import http from 'node:http';
import path from 'node:path';
import { openScript } from './scripts.mjs';
import { listFormats, formatPreview, readBytes, readDeclaration } from '../server/formats.mjs';
import { dashboardAction, dashboardActions, dashboardRunPayload, dashboardCapture } from '../server/dashboard.mjs';
import { inspectGame } from '../server/games.mjs';
import { projectDevices } from '../server/devices.mjs';
import { LOCAL } from '../server/device-rules.mjs';
import { listRecordings, readRecording } from '../server/recordings.mjs';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { Desktops } from '../server/desktops.mjs';
import { request as call } from '../launcher/sidecar.mjs';
import { authenticated, body, checkConnection, fail, forward, json } from './protocol.mjs';
import { hostStateDirectory, readTasks, trackerSignIn, trackerSignOut } from './tracker.mjs';
import { agentsMenu, modelArgs, promptFor, promptValues, taskWrite } from '../server/tasks.mjs';
import { startIdeBridge } from './ide.mjs';
import { runtimeDirectory, alive, discoverRuntime } from './discovery.mjs';
import { Tokens, UUID, readIdentity, readDesktop, segmentFrame } from './token.mjs';

/* Named once because a monitor reads it: the close reason a retired worker gives its feed clients
   so they re-read feed_url and reattach to the current worker from the cursor they had. */
export const RETIRED_FEED = 'Workspace worker retired; re-read feed_url and resume from your cursor';
/* The routes a retired worker forwards, by method: `GET /api/recording` reads a recording out of the
   project and is nobody's ledger, while `POST /api/recording` is the desktop's frame. */
const RETIRED_ROUTES = new Map([['/api/token', 'GET'], ['/api/token-action', 'POST'], ['/api/feed', 'GET'],
  ['/api/recording', 'POST'], ['/api/preferences', 'POST'],
  /* Both are gated by the ledger and both mint a feed frame, so they belong to the worker that owns
     it: a retired worker forwarding them keeps one writer and one sequence (spec 103). */
  ['/api/task', 'POST'], ['/api/agent-spawn', 'POST']]);

/* A `desktop-register` frame, minus the sessions this host state does not have. Those ended with the
   host the desktop's saved layout was written under (spec 098); a malformed frame is left exactly as
   it arrived so `Desktops.register` refuses it by name. */
export function withoutEndedSessions(data, state) {
  if (!Array.isArray(data.sessionIds)) return { frame: data, dropped: [] };
  const live = new Set((state?.sessions ?? []).map(session => session.id));
  const dropped = data.sessionIds.filter(id => !live.has(id));
  return dropped.length ? { frame: { ...data, sessionIds: data.sessionIds.filter(id => live.has(id)) }, dropped } : { frame: data, dropped: [] };
}

export async function startWorker(host, options = {}) {
  checkConnection(host);
  const state = await call(host, 'state');
  if (state.instance !== host.instance) fail('Session host identity changed.');
  let bindings = state, url;
  /* Found once: the host's instance does not change while this worker lives. See sidecar: tracker-routes. */
  const located = await hostStateDirectory(host, state);
  /* The lock Claude Code reads must name a process that is one of a pane's own ancestors, and only
     the session host is (spec 102). A host from this checkout says its pid; a retained one is found
     in the process table by the same scan the tracker uses. See sidecar: ide-names-the-host.  */
  const hostPid = located.pid ?? (Number.isInteger(state.pid) ? state.pid : undefined);
  let ide = null;
  if (options.ide !== false) {
    ide = await startIdeBridge({ roots: state.roots.map(root => root.path), hostPid, port: options.idePort ?? 0, ...options.ideOptions })
      .catch(error => ({ published: false, reason: error.message }));
  }
  const token = randomBytes(32).toString('hex');
  const root = id => bindings.roots.find(x => x.id === id) ?? fail('Unknown project root.', 404);
  const snapshot = id => bindings.sessions.find(x => x.id === id) ?? fail('Unknown session.', 404);
  const desktops = new Desktops({ root }, { snapshot });
  /* The last registration this worker refused, so the supervisor's `waitView` can name the reason a
     desktop never appeared instead of only that it did not (spec 098). */
  let registerError = null;
  const refresh = async () => { const state = await call(host, 'state'); if (state.instance !== host.instance) fail('Session host identity changed.'); bindings = state; return state; };
  /* Preflight runs here, from this checkout, exactly as the dashboard does; only the launch needs
     the retained host, which owns the PTY and the embedded surface. See sidecar: game-routes. */
  const preflight = (rootId, gameId) => inspectGame(root(rootId), gameId);
  /* The ledger is the only capability this worker advertises conditionally: a worker whose runtime
     directory it cannot own serves everything else and says agentToken nowhere, so the tools refuse
     by name instead of calling a worker that would pass every gate (spec 095, criterion 8). */
  let tokens = null, ledgerError = null, servesLedger = false, retired = false, supervisor = null;
  const directory = options.directory ?? runtimeDirectory(host);
  try { tokens = await Tokens.open(directory, { alive }); servesLedger = true; }
  catch (error) { ledgerError = error.message; }
  /* servesLedger, not tokens: a retired worker no longer owns the ledger but still answers for it,
     by forwarding to the worker that does, so the capability it advertises does not change. */
  /* taskWrites and agentSpawn ride with agentToken for the same reason: both are token-gated and
     both announce themselves on the feed, so a worker that owns no ledger cannot serve either and
     says so by naming neither (spec 078's asymmetry — the caller is refused by name rather than
     calling a worker that would pass every gate because it has none). */
  const capabilities = ({ projectGameLaunch, ...rest }) => ({ ...rest, desktopActions: 1, layeredUpdates: 1, scriptActions: 1,
    formatRegistry: 1, dashboard: 1, projectGame: 1, recordings: 1, projectDevices: 1, tracker: 1, agentsMenu: 1,
    ...(servesLedger ? { agentToken: 1, taskWrites: 1, agentSpawn: 1 } : {}), ...(rest.projectGame === 1 ? { projectGameLaunch: 1 } : {}) });
  /* Refused here, from the worker's own preflight, before anything reaches the retained host: the
     spec-078 / KI-043 lesson is that the host must not be the one to answer. See sidecar: remote-launch. */
  const refuseRemote = async (rootId, gameId) => {
    const config = await preflight(rootId, gameId);
    if (config.refusal) fail(config.refusal, 409);
  };
  const launch = payload => {
    if (bindings.capabilities?.projectGame !== 1) {
      fail('This retained session host predates per-project game declarations and would launch its removed built-in game; game_preflight answers from the declaration. Replacing the session host requires quiescence.', 409);
    }
    return call(host, 'game', payload);
  };

  /* --- the project token (spec 095) --------------------------------------------------------- */
  const attribution = new Map(), deviceActions = new Map(), announced = new Map(), launches = new Map();
  /* The host announces a new session before the launch call returns, so who asked cannot be looked
     up by session id at that point. Each launch queues its asker on the root first; the frame takes
     the oldest still-fresh entry, and a launch the host coalesced onto a session that already
     existed takes its own entry back. */
  const queueLaunch = (rootId, by) => { const list = launches.get(rootId) ?? []; list.push({ by, at: Date.now() }); launches.set(rootId, list); };
  const nextLauncher = rootId => {
    const list = launches.get(rootId);
    while (list?.length) { const entry = list.shift(); if (Date.now() - entry.at < 10000) return entry.by; }
    return null;
  };
  const actor = (who, headers = {}) => {
    if (who) return { kind: 'agent', agentId: who.agentId, label: who.label };
    const desktopId = readDesktop(headers);
    return { kind: 'desktop', ...(desktopId ? { desktopId } : {}) };
  };
  const note = async (rootId, type, by, fields) => {
    if (!tokens || !rootId) return null;
    const ledger = await tokens.ledger(rootId);
    const frame = ledger.frame(type, by, fields);
    await ledger.persist();
    return frame;
  };
  /* A request with no X-Rengine-Agent header is the desktop's, and the desktop is never gated
     (decision 6). The header is arbitration, not authentication — see token.mjs. */
  const gate = async (req, rootId, tool) => {
    const who = readIdentity(req.headers);
    if (!who || !tokens) return { who, by: actor(who, req.headers) };
    const ledger = await tokens.ledger(rootId);
    await ledger.settle();
    ledger.seen(who);
    const refusal = ledger.refusal(who, tool);
    await ledger.persist();
    if (refusal) fail(refusal, 409);
    return { who, by: actor(who, req.headers) };
  };
  /* The ledger learns an agentId only from a header on the wire, so a lane that has not called
     anything yet is invisible to token_status and un-nameable. Spec 097's persisted conversations
     are identities this root already has, so they are folded in: never minted, never overriding one
     the ledger has actually seen, and marked so a reader can tell the two apart. */
  const printableName = value => String(value ?? 'agent').replace(/[^\x20-\x7e]/g, '').slice(0, 32) || 'agent';
  const asIso = value => (Number.isFinite(value) ? new Date(value) : new Date()).toISOString();
  const withConversations = (status, rootId) => {
    const seen = new Set(status.identities.map(entry => entry.agentId));
    const listed = Array.isArray(bindings.conversations?.[rootId]) ? bindings.conversations[rootId] : [];
    const extra = [];
    for (const entry of listed) {
      if (!UUID.test(entry?.id ?? '') || seen.has(entry.id)) continue;
      seen.add(entry.id);
      extra.push({ agentId: entry.id, label: `${printableName(entry.agent)} ${entry.id.slice(0, 8)}`,
        firstSeenAt: asIso(entry.startedAt), lastSeenAt: asIso(entry.lastSeenAt), conversation: true });
    }
    return extra.length ? { ...status, identities: [...status.identities, ...extra] } : status;
  };
  const conversationsOf = rootId => Array.isArray(bindings.conversations?.[rootId]) ? bindings.conversations[rootId] : [];
  /* An agent the Tasks pane can list is not necessarily one the ledger has met on the wire, so the
     desktop's assign resolves through the conversations this project remembers as well (spec 103). */
  const conversationIdentity = (rootId, agentId) => {
    const entry = conversationsOf(rootId).find(item => item?.id === agentId);
    return entry ? { agentId, label: `${printableName(entry.agent)} ${agentId.slice(0, 8)}` } : null;
  };

  /* --- task writes and agent spawns (spec 103) ----------------------------------------------- */
  /* One write at a time per root, behind the gate rather than instead of it: a non-holder is refused
     before it reaches the queue, and two holders in sequence queue rather than interleave. A write
     that throws still advances the chain, so one project's failure never wedges the next call. */
  const writing = new Map();
  const serialised = (rootId, run) => {
    const next = (writing.get(rootId) ?? Promise.resolve()).then(run, run);
    writing.set(rootId, next.then(() => {}, () => {}));
    return next;
  };
  const declarationOf = rootId => readDeclaration(root(rootId));
  const taskRow = async (rootId, key) => {
    const listed = await readTasks(root(rootId), located);
    const row = listed.rows?.find(item => item.key === key || String(item.id) === String(key));
    if (!row) fail(`No task ${JSON.stringify(key)} is in this project's tracker; list_tasks names the keys it has. Nothing was started.`, 404);
    return row;
  };
  /* The CLI's own initial prompt is a positional argument after the model flag, which is how both
     claude and codex take one. The pane's own launcher appends these after the MCP wiring. */
  const spawnAgent = async (data, by) => {
    if (bindings.capabilities?.taskConversations !== 1) {
      fail('This retained session host predates task-driven agent panes: it neither records the task on a conversation nor passes a pane\'s arguments to its CLI, so a spawn would start an agent with no prompt. Replacing the session host requires quiescence. Nothing was started.', 409);
    }
    const rootId = root(data.rootId).id;
    const agent = typeof data.agent === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(data.agent) ? data.agent : fail('Choose an agent CLI to spawn.');
    const brief = data.brief ?? 'task';
    const row = await taskRow(rootId, data.taskKey);
    const args = [...modelArgs(agent, data.model), (await promptFor(root(rootId), brief, promptValues(row))).text];
    const session = await call(host, 'terminal', { rootId, type: 'agent', agent, action: 'launch', args });
    /* A CLI rEngine can name a conversation for has one already; one that names its own has none to
       carry the task, and the frame says so rather than inventing an id. */
    if (session?.conversation) {
      await call(host, 'agent-conversation', { id: session.id, conversation: session.conversation, agent, task: row.key });
    }
    const frame = await note(rootId, 'agent.spawned', by, { taskKey: row.key, agent, model: data.model ?? null,
      conversation: session?.conversation ?? null, sessionId: session?.id ?? null });
    await refresh();
    const result = { rootId, taskKey: row.key, agent, model: data.model ?? null, brief,
      conversation: session?.conversation ?? null, session, sequence: frame?.sequence ?? null };
    if (data.desktopId === undefined) return result;
    /* Attached exactly as a script tab is: the pane is already running and retained, so a failure to
       show it is reported rather than retried, and nothing is ever spawned twice. */
    try { return { ...result, view: await desktops.attach(rootId, data.desktopId, session) }; }
    catch (error) {
      return { ...result, view: { status: 'not_attached', error: error.message },
        detail: 'The agent pane was started and is retained. Use show_session; do not spawn it again.' };
    }
  };
  const tokenStatus = async (rootId, req, tool) => {
    if (!tokens) fail(`This workspace worker does not serve the project token ledger: ${ledgerError ?? 'no runtime directory'}.`, 409);
    const who = readIdentity(req.headers);
    const ledger = await tokens.ledger(rootId);
    await ledger.settle();
    if (who) { ledger.seen(who); await ledger.persist(); }
    return { ...withConversations(ledger.status(who), rootId), caller: who, refusal: ledger.refusal(who, tool), feed: feedUrl(rootId) };
  };
  const feedUrl = rootId => `${url.replace('http:', 'ws:')}/feed?${new URLSearchParams({ rootId, token })}`;
  /* One announcement per worker process, on the first request that is not a health or state probe:
     a candidate the supervisor prepares and then discards only ever answers those two, so a worker
     that never served anybody never claims a generation. */
  let generation = null;
  const announce = async () => {
    if (generation !== null || !tokens) return;
    generation = await tokens.bumpGeneration();
    for (const item of bindings.roots) {
      await note(item.id, 'workspace.updated', { kind: 'workspace', pid: process.pid }, { layers: ['workspace'], generation });
    }
  };
  const desktopOf = client => desktops.clients.get(client);

  /* --- retirement (spec 095, Retirement) ----------------------------------------------------- */
  /* Spec 065 keeps this worker's streams draining after it is replaced, so the desktop's /events
     socket stays here; spec 095 put a stateful service on that socket. Retirement splits the two:
     terminal and surface views keep draining, and the token/feed service hands off to the current
     worker, reached through the supervisor named by the runtime descriptor in this directory. */
  const feeds = new Set(), relays = new Map(), relayAttempts = new Map();
  const supervisorOf = async () => {
    if (supervisor) return supervisor;
    const found = await discoverRuntime(host, directory);
    if (!found) fail('This workspace worker was retired and its runtime supervisor is gone; reopen the workspace.', 503);
    supervisor = found;
    return supervisor;
  };
  const relay = async (route, data, headers) => call(await supervisorOf(), route, data, headers);
  /* A retired worker mints nothing, so a transition on the current ledger reaches its retained
     desktops the only way left: it watches that ledger's feed for token.* and re-reads the status
     through the supervisor, pushing the same pinned frame it used to build itself. */
  const follow = async rootId => {
    if (!retired || closing || relays.has(rootId)) return;
    const entry = { socket: null };
    relays.set(rootId, entry);
    /* The count lives outside the entry, so a supervisor that never answers gives up after twenty
       tries rather than looping; a socket that opened resets it, because the current worker being
       replaced in turn is a reconnection this relay is supposed to follow. */
    const again = () => {
      relays.delete(rootId);
      const attempts = (relayAttempts.get(rootId) ?? 0) + 1;
      relayAttempts.set(rootId, attempts);
      if (closing || !retired || attempts > 20) return;
      setTimeout(() => void follow(rootId).catch(() => {}), 250).unref?.();
    };
    try {
      const read = await relay(`feed?${new URLSearchParams({ rootId })}`);
      if (closing || !retired) { relays.delete(rootId); return; }
      const socket = new WebSocket(`${read.socket}&after=${read.cursor}`);
      entry.socket = socket;
      socket.on('error', () => {});
      socket.once('open', () => relayAttempts.delete(rootId));
      socket.on('message', bytes => {
        let frame; try { frame = JSON.parse(bytes); } catch { return; }
        if (typeof frame?.type === 'string' && frame.type.startsWith('token.')) void pushToken(rootId).catch(() => {});
      });
      socket.once('close', again);
    } catch { again(); }
  };
  const retire = async () => {
    if (retired) return;
    retired = true;
    /* Released at retirement rather than at close, so `/ide` lists one rEdit again as soon as the
       supervisor has switched; `--ide` connects only when exactly one is offered. */
    await ide?.close?.();
    ide = null;
    hostStream?.terminate(); hostStream = null;
    for (const client of feeds) { try { client.close(1001, RETIRED_FEED); } catch { /* already gone */ } }
    feeds.clear();
    const owned = tokens; tokens = null;
    await owned?.close();
    for (const rootId of new Set([...desktops.clients.values()].flatMap(desktop => desktop.rootIds ?? []))) await follow(rootId);
  };

  /* The pinned worker->desktop frame (spec 095, Native desktop): flat holder/contest/windowMs plus
     the sequence of the last token.* frame, pushed to every desktop bound to the root when it
     registers and after every transition, so the status-bar segment never polls. A retired worker
     builds the same frame from the current worker's status instead of from a ledger it gave up. */
  const pushToken = async (rootId, only = null) => {
    if (!tokens && !retired) return;
    const frame = retired ? segmentFrame(await relay(`token?${new URLSearchParams({ rootId })}`))
      : (await tokens.ledger(rootId)).segment();
    const message = JSON.stringify(frame);
    for (const desktop of desktops.clients.values()) {
      if (only && desktop.socket !== only) continue;
      if (desktop.rootIds?.includes(rootId) && desktop.socket.readyState === WebSocket.OPEN) desktop.socket.send(message);
    }
  };
  const desktopToken = async (client, data) => {
    const desktop = desktopOf(client);
    if (!desktop) fail('Register the desktop before sending token actions.', 409);
    if (!desktop.rootIds.includes(data.rootId)) fail('That project is not bound to this desktop.', 403);
    /* An assign resolves an agent id against the conversations this project remembers, and those
       live in the host's state: this socket has no other reason to re-read it, so a conversation
       started since this worker did would be unknown to a frame that names it. */
    if (data.action === 'assign') await refresh();
    if (retired) {
      await relay('token-action', { rootId: data.rootId, action: data.action, contestId: data.contestId, reason: data.reason, agentId: data.agentId },
        { 'X-Rengine-Desktop': desktop.id });
      return;
    }
    if (!tokens) fail('This workspace worker does not serve the project token ledger.', 409);
    const ledger = await tokens.ledger(data.rootId);
    await ledger.desktop(data.action, { contestId: data.contestId, desktopId: desktop.id, reason: data.reason,
      agentId: data.agentId, lookup: id => conversationIdentity(data.rootId, id) });
    await pushToken(data.rootId);
  };
  /* The recorder lives in the desktop (spec 081), so a commit is announced by the desktop on the
     same socket it registers on. One function behind both ways in: that socket, and the route a
     retired worker forwards it to. */
  const recordingFrame = async (rootId, data, by) => {
    if (!tokens) fail('This workspace worker does not serve the project token ledger.', 409);
    if (!['started', 'committed'].includes(data.event)) fail('A recording frame carries event started or committed.');
    const frame = await note(rootId, data.event === 'started' ? 'capture.started' : 'capture.committed', by,
      { sessionId: data.sessionId ?? null, gameId: data.gameId ?? null, recordingId: data.recordingId ?? null,
        kind: data.kind === 'explicit' ? 'explicit' : 'ring', ...(data.at ? { startedAt: String(data.at).slice(0, 40) } : {}),
        ...(data.error ? { error: String(data.error).slice(0, 400) } : {}) });
    return { rootId, type: frame?.type ?? null, sequence: frame?.sequence ?? null };
  };
  const desktopRecording = async (client, data) => {
    const desktop = desktopOf(client);
    if (!desktop) fail('Register the desktop before sending recording frames.', 409);
    if (!desktop.rootIds.includes(data.rootId)) fail('That project is not bound to this desktop.', 403);
    if (retired) { await relay('recording', data, { 'X-Rengine-Desktop': desktop.id }); return; }
    await recordingFrame(data.rootId, data, { kind: 'desktop', desktopId: desktop.id });
  };
  /* The worker subscribes to the retained host's stream itself, once, with no desktop behind it. It
     reads session transitions and nothing else: an `output` frame is never even parsed into a feed
     frame, which is what makes "no PTY output on the feed" structural rather than a filter. */
  let hostStream = null, closing = false, retries = 0;
  const onSession = async session => {
    if (!tokens || !session?.id) return;
    const running = session.state === 'running';
    const pending = deviceActions.get(session.id);
    if (pending && !running) {
      deviceActions.delete(session.id);
      await note(session.rootId ?? pending.rootId, 'device-action.ended', pending.by, { ...pending.fields, exitCode: session.exitCode ?? null });
    }
    const open = announced.get(session.id);
    if (!open && session.type !== 'game') return;
    if (running && !open) {
      const record = { rootId: session.rootId, gameId: session.game ?? null, surface: session.surface ?? null, args: session.args ?? [],
        by: attribution.get(session.id) ?? nextLauncher(session.rootId) ?? { kind: 'workspace' } };
      announced.set(session.id, record);
      await note(record.rootId, 'game.started', record.by, { sessionId: session.id, gameId: record.gameId, surface: record.surface, args: record.args });
    } else if (!running && open) {
      announced.delete(session.id); attribution.delete(session.id);
      await note(session.rootId ?? open.rootId, 'game.ended', open.by,
        { sessionId: session.id, gameId: open.gameId, surface: open.surface, args: open.args, exitCode: session.exitCode ?? null });
    }
  };
  /* A replaced worker inherits the open pairs from the retained ring rather than a lost Map, so the
     `ended` half of a game or a device action still lands, and a `started` is never repeated. */
  const prime = async () => {
    if (!tokens) return;
    for (const item of bindings.roots) {
      const ledger = await tokens.ledger(item.id);
      for (const frame of ledger.feed.frames) {
        if (frame.type === 'game.started') announced.set(frame.sessionId, { rootId: frame.rootId, gameId: frame.gameId, surface: frame.surface, args: frame.args ?? [], by: frame.by });
        else if (frame.type === 'game.ended') announced.delete(frame.sessionId);
        else if (frame.type === 'device-action.started') {
          deviceActions.set(frame.sessionId, { rootId: frame.rootId, by: frame.by, fields: { sessionId: frame.sessionId, actionId: frame.actionId, deviceId: frame.deviceId, kind: frame.kind } });
        } else if (frame.type === 'device-action.ended') deviceActions.delete(frame.sessionId);
      }
    }
    for (const id of [...announced.keys(), ...deviceActions.keys()]) {
      const session = bindings.sessions.find(item => item.id === id);
      if (!session || session.state !== 'running') await onSession(session ?? { id, type: 'game', state: 'exited' });
    }
  };
  const subscribe = () => {
    if (closing || retired || !tokens) return;
    const remote = new URL('/events', host.url); remote.protocol = 'ws:'; remote.searchParams.set('token', host.token);
    hostStream = new WebSocket(remote);
    hostStream.on('error', () => {});
    hostStream.on('message', bytes => {
      let data; try { data = JSON.parse(bytes); } catch { return; }
      if (data?.type === 'session') void onSession(data.session).catch(() => {});
    });
    hostStream.once('close', () => { if (closing || retired || retries++ > 20) return; setTimeout(subscribe, 250).unref?.(); });
  };

  const server = http.createServer(async (req, res) => {
    try {
      const target = new URL(req.url, 'http://127.0.0.1');
      if (target.pathname === '/health') { json(res, 200, { protocol: 1, instance: host.instance, worker: process.pid }); return; }
      if (!authenticated(req, token, url)) fail('Workspace authentication required.', 401);
      /* Retired: the ledger belongs to the worker that replaced this one, so every route that reads
         or writes it — including the tokenWindowMs half of a preferences write, which that worker
         splits exactly as this one did — is answered by forwarding through the supervisor. */
      if (retired && RETIRED_ROUTES.get(target.pathname) === req.method) { forward(req, res, await supervisorOf()); return; }
      if (req.method === 'GET' && target.pathname === '/api/state') {
        const state = await refresh();
        json(res, 200, { ...state, preferences: { ...state.preferences, ...(tokens ? { tokenWindowMs: tokens.window() } : {}) }, capabilities: capabilities(state.capabilities) });
      } else if (req.method === 'POST' && target.pathname === '/api/preferences') {
        /* The host's preference store allowlists its keys and drops the ones it does not know, so
           tokenWindowMs is kept beside the ledger and the rest is forwarded unchanged. */
        const { tokenWindowMs, ...rest } = await body(req);
        if (tokenWindowMs !== undefined) { if (!tokens) fail('This workspace worker does not serve the project token ledger.', 409); await tokens.setWindow(tokenWindowMs); }
        const preferences = await call(host, 'preferences', rest);
        json(res, 200, { ...preferences, ...(tokens ? { tokenWindowMs: tokens.window() } : {}) });
      } else if (req.method === 'GET' && target.pathname === '/api/token') {
        await refresh(); await announce();
        json(res, 200, await tokenStatus(root(target.searchParams.get('rootId')).id, req, (target.searchParams.get('tool') ?? '').replace(/[^a-z_]/g, '').slice(0, 40)));
      } else if (req.method === 'POST' && target.pathname === '/api/token-action') {
        const data = await body(req); await refresh(); await announce();
        if (!tokens) fail(`This workspace worker does not serve the project token ledger: ${ledgerError ?? 'no runtime directory'}.`, 409);
        const who = readIdentity(req.headers);
        /* The desktop actor a retired worker forwards for one of its retained desktops. Honoured
           only in the absence of an agent header, and answered exactly as a local desktop socket
           is: the person at a desktop is never gated, whichever worker carries the frame. */
        const desktopId = who ? null : readDesktop(req.headers);
        if (!who && !desktopId) fail('Only an identified agent can act on the token; this request carried no X-Rengine-Agent header.', 403);
        const ledger = await tokens.ledger(root(data.rootId).id);
        const result = desktopId ? await ledger.desktop(data.action, { contestId: data.contestId, desktopId, reason: data.reason,
            agentId: data.agentId, lookup: id => conversationIdentity(root(data.rootId).id, id) })
          : data.action === 'contest' ? await ledger.contest(who, data.reason)
          : data.action === 'reject' ? await ledger.reject(who, data.reason)
          : data.action === 'release' ? await ledger.release(who)
          : fail('Choose contest, reject or release.');
        await pushToken(data.rootId);
        json(res, 200, { ...result, status: ledger.status(who) });
      } else if (req.method === 'POST' && target.pathname === '/api/recording') {
        /* The desktop's own recording frame, arriving over HTTP because the desktop that sent it is
           draining through a retired worker. Same body, same frames, same attribution. */
        const data = await body(req); await refresh(); await announce();
        const desktopId = readIdentity(req.headers) ? null : readDesktop(req.headers);
        if (!desktopId) fail('A recording frame is the desktop\'s; this request carried no X-Rengine-Desktop header.', 403);
        json(res, 200, await recordingFrame(root(data.rootId).id, data, { kind: 'desktop', desktopId }));
      } else if (req.method === 'GET' && target.pathname === '/api/feed') {
        await refresh(); await announce();
        if (!tokens) fail(`This workspace worker does not serve the project token ledger: ${ledgerError ?? 'no runtime directory'}.`, 409);
        const rootId = root(target.searchParams.get('rootId')).id;
        const ledger = await tokens.ledger(rootId);
        const after = Number(target.searchParams.get('after') ?? 0), limit = Number(target.searchParams.get('limit') ?? 200);
        json(res, 200, { ...ledger.feed.after(Number.isSafeInteger(after) ? after : 0, Number.isSafeInteger(limit) ? Math.min(limit, 1000) : 200),
          rootId, socket: feedUrl(rootId) });
      } else if (req.method === 'POST' && target.pathname === '/api/script-open') {
        const data = await body(req); const state = await refresh(); await announce();
        await gate(req, root(data.rootId).id, 'open_script');
        json(res, 200, await openScript(host, desktops, data, state));
      } else if (req.method === 'POST' && target.pathname === '/api/session-view') {
        const data = await body(req); await refresh(); await announce();
        json(res, 200, await desktops.attach(data.rootId, data.desktopId, snapshot(data.id)));
      } else if (req.method === 'GET' && target.pathname === '/api/formats') {
        await refresh(); json(res, 200, await listFormats(root(target.searchParams.get('rootId'))));
      } else if (req.method === 'POST' && target.pathname === '/api/format-preview') {
        const data = await body(req); await refresh(); json(res, 200, await formatPreview(root(data.rootId), data));
      } else if (req.method === 'GET' && target.pathname === '/api/bytes') {
        await refresh(); json(res, 200, await readBytes(root(target.searchParams.get('rootId')), Object.fromEntries(target.searchParams)));
      } else if (req.method === 'GET' && target.pathname === '/api/game-config') {
        await refresh(); json(res, 200, await preflight(target.searchParams.get('rootId'), target.searchParams.get('gameId') ?? undefined));
      } else if (req.method === 'GET' && target.pathname === '/api/devices') {
        await refresh();
        const selected = root(target.searchParams.get('rootId'));
        json(res, 200, await projectDevices(selected, await readDeclaration(selected),
          { refresh: target.searchParams.get('refresh') === '1', preflight, resolve: () => dashboardActions(selected, preflight) }));
      } else if (req.method === 'POST' && target.pathname === '/api/game') {
        const data = await body(req); await refresh(); await announce();
        const { by } = await gate(req, root(data.rootId).id, 'launch_game');
        await refuseRemote(data.rootId, data.gameId ?? undefined);
        const running = new Set(bindings.sessions.map(item => item.id));
        queueLaunch(data.rootId, by);
        const session = await launch({ rootId: data.rootId, ...(data.gameId === undefined ? {} : { gameId: data.gameId }), ...(data.args === undefined ? {} : { args: data.args }) })
          .catch(error => { nextLauncher(data.rootId); throw error; });
        if (session?.id) { attribution.set(session.id, by); if (running.has(session.id)) nextLauncher(data.rootId); }
        json(res, 200, session);
      } else if (req.method === 'POST' && target.pathname === '/api/stop') {
        /* The retained host serves /api/stop and this worker only forwards it, so the gate has to
           intercept before the forward rather than ask the host to grow one (spec 065). */
        const data = await body(req); await refresh(); await announce();
        await gate(req, snapshot(data.id).rootId, 'stop_session');
        json(res, 200, await call(host, 'stop', { id: data.id }));
      } else if (req.method === 'POST' && target.pathname === '/api/agent-restart') {
        /* Intercepted for the same reason as /api/stop, and gated for the same reason: restarting an
           agent pane stops that child, which is one of the exclusive things decision 4 names. The
           person at the desktop sends no identity header and is never gated (decision 6). */
        const data = await body(req); await refresh(); await announce();
        await gate(req, snapshot(data.id).rootId, 'restart_agent');
        json(res, 200, await call(host, 'agent-restart', { id: data.id }));
      } else if (req.method === 'POST' && target.pathname === '/api/update-workspace') {
        const data = await body(req); await refresh(); await announce();
        await gate(req, root(data.rootId).id, 'update_workspace');
        json(res, 202, await call(host, 'update-workspace', data));
      } else if (req.method === 'GET' && target.pathname === '/api/recordings') {
        await refresh(); json(res, 200, await listRecordings(root(target.searchParams.get('rootId')), Object.fromEntries(target.searchParams)));
      } else if (req.method === 'GET' && target.pathname === '/api/recording') {
        await refresh();
        json(res, 200, await readRecording(root(target.searchParams.get('rootId')), target.searchParams.get('id'), Object.fromEntries(target.searchParams)));
      } else if (req.method === 'GET' && target.pathname === '/api/tracker') {
        await refresh(); json(res, 200, await readTasks(root(target.searchParams.get('rootId')), located, { refresh: target.searchParams.get('refresh') === '1' }));
      } else if (req.method === 'POST' && target.pathname === '/api/task') {
        /* Spec 103 decision 2: token-gated and serialised. The gate refuses a non-holder before the
           queue, so a refusal never waits behind somebody else's write, and the frame is minted
           after the project's own command returned rather than when it was asked for. */
        const data = await body(req); await refresh(); await announce();
        const selected = root(data.rootId), { by } = await gate(req, selected.id, `task_${data.action ?? 'write'}`);
        const written = await serialised(selected.id, async () => taskWrite(selected, await declarationOf(selected.id), data));
        const frame = await note(selected.id, data.action === 'update' ? 'task.updated' : 'task.added', by,
          { key: written.key, action: data.action });
        json(res, 200, { ...written, sequence: frame?.sequence ?? null, tracker: await readTasks(selected, located, { refresh: true }) });
      } else if (req.method === 'POST' && target.pathname === '/api/agent-spawn') {
        const data = await body(req); await refresh(); await announce();
        const { by } = await gate(req, root(data.rootId).id, 'spawn_agent');
        json(res, 200, await spawnAgent(data, by));
      } else if (req.method === 'GET' && target.pathname === '/api/agents-menu') {
        await refresh();
        const selected = root(target.searchParams.get('rootId'));
        const menu = await agentsMenu(selected, await readDeclaration(selected));
        const remembered = new Map(conversationsOf(selected.id).map(entry => [entry.id, entry]));
        json(res, 200, { ...menu, live: bindings.sessions.filter(item => item.rootId === selected.id && item.type === 'agent' && item.state === 'running')
          .map(item => ({ sessionId: item.id, conversation: item.conversation ?? null,
            label: item.conversation ? `${printableName(item.agent)} ${item.conversation.slice(0, 8)}` : printableName(item.agent),
            task: item.task ?? remembered.get(item.conversation)?.task ?? null })) });
      } else if (req.method === 'POST' && target.pathname === '/api/tracker/signin') {
        const data = await body(req); await refresh(); json(res, 200, await trackerSignIn(root(data.rootId), located));
      } else if (req.method === 'POST' && target.pathname === '/api/ide-selection') {
        /* The desktop reports a fact about itself — which file, which range — and this turns it into
           the notification Claude Code understands. The path is resolved here because roots live
           here: the desktop names a root and a path within it, as every other route does. */
        const data = await body(req);
        const selected = root(data.rootId);
        json(res, 200, { delivered: ide?.published
          ? ide.selection({ filePath: path.join(selected.path, data.path ?? ''), text: data.text ?? '', selection: data.selection })
          : 0 });
      } else if (req.method === 'POST' && target.pathname === '/api/tracker/signout') {
        const data = await body(req); await refresh(); json(res, 200, await trackerSignOut(root(data.rootId), located));
      } else if (req.method === 'GET' && target.pathname === '/api/dashboard') {
        await refresh(); json(res, 200, await dashboardActions(root(target.searchParams.get('rootId')), preflight));
      } else if (req.method === 'POST' && target.pathname === '/api/dashboard-run') {
        const data = await body(req); await refresh(); await announce();
        const selected = root(data.rootId), { by } = await gate(req, selected.id, 'dashboard_run');
        const action = await dashboardAction(selected, data.actionId, preflight);
        if (action.kind === 'game') {
          await refuseRemote(selected.id, action.game);
          const running = new Set(bindings.sessions.map(item => item.id));
          queueLaunch(selected.id, by);
          const session = await launch({ rootId: selected.id, gameId: action.game, args: action.args ?? [] })
            .catch(error => { nextLauncher(selected.id); throw error; });
          if (session?.id) { attribution.set(session.id, by); if (running.has(session.id)) nextLauncher(selected.id); }
          json(res, 200, session); return;
        }
        const payload = await dashboardRunPayload(selected, action);
        const created = await call(host, 'terminal', payload);
        /* The owner's "deploying to device", named generally: any action whose declared device is
           not this machine is a device-bound action, and its session bounds the frame pair. */
        if (created?.id && action.device && action.device.kind !== LOCAL) {
          const fields = { sessionId: created.id, actionId: action.id, deviceId: action.device.id, kind: action.device.kind };
          deviceActions.set(created.id, { rootId: selected.id, by, fields });
          await note(selected.id, 'device-action.started', by, fields);
        }
        json(res, 200, { ...created, title: payload.title }); /* the retained host may predate session titles */
      } else if (req.method === 'POST' && target.pathname === '/api/dashboard-capture') {
        const data = await body(req); await refresh(); await announce();
        await gate(req, root(data.rootId).id, 'dashboard_capture');
        json(res, 200, await dashboardCapture(root(data.rootId), data.actionId, preflight));
      } else if (req.method === 'GET' && target.pathname === '/api/desktops') {
        await refresh(); json(res, 200, { desktops: desktops.list(target.searchParams.get('rootId')) });
      } else if (req.method === 'GET' && target.pathname === '/api/runtime-desktops') {
        json(res, 200, { desktops: [...desktops.clients.values()].map(({ socket, ...desktop }) => desktop), registerError });
      } else if (req.method === 'POST' && target.pathname === '/api/desktop-action') {
        const data = await body(req); await refresh(); await announce();
        if (data.action !== 'reload') fail('Unknown desktop action.');
        await gate(req, root(data.rootId).id, 'reload_desktop');
        json(res, 200, await desktops.reload(data.rootId, data.desktopId));
      } else { await announce(); forward(req, res, host); }
    } catch (error) { if (!res.headersSent) json(res, error.status ?? 500, { error: error.message }); else res.destroy(); }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  /* The feed is served here and nowhere else: the retained host never sees this route, and no frame
     on it is ever a byte a process printed. */
  const serveFeed = async (client, target) => {
    client.on('error', () => {});
    try {
      if (retired) throw new Error(RETIRED_FEED);
      if (!tokens) throw new Error('This workspace worker does not serve the project token ledger.');
      await refresh();
      const rootId = root(target.searchParams.get('rootId')).id;
      const ledger = await tokens.ledger(rootId);
      const after = Number(target.searchParams.get('after') ?? 0);
      const send = frame => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > 1024 * 1024) client.close(1013, 'Reopen the feed with the last sequence you read');
        else client.send(JSON.stringify(frame));
      };
      for (const frame of ledger.feed.after(Number.isSafeInteger(after) ? after : 0).frames) send(frame);
      const unsubscribe = ledger.feed.subscribe(send);
      feeds.add(client);
      client.once('close', () => { feeds.delete(client); unsubscribe(); });
    } catch (error) { client.close(1011, error.message.slice(0, 100)); }
  };
  server.on('upgrade', (req, socket, head) => {
    const target = new URL(req.url, 'http://127.0.0.1');
    req.headers.authorization = `Bearer ${target.searchParams.get('token')}`;
    if (!['/events', '/surface', '/feed'].includes(target.pathname) || !authenticated(req, token, url)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    if (target.pathname === '/feed') { sockets.handleUpgrade(req, socket, head, client => void serveFeed(client, target)); return; }
    sockets.handleUpgrade(req, socket, head, client => {
      const remote = new URL(req.url, host.url); remote.protocol = 'ws:'; remote.searchParams.set('token', host.token);
      const upstream = new WebSocket(remote); let chain = Promise.resolve();
      const opened = new Promise((resolve, reject) => { upstream.once('open', resolve); upstream.once('error', reject); });
      opened.catch(() => client.close(1011, 'Session host unavailable'));
      const send = (destination, bytes, binary = false) => {
        if (destination.readyState !== WebSocket.OPEN) return;
        if (destination.bufferedAmount > 4 * 1024 * 1024) destination.close(1013, 'Reconnect to retained session');
        else destination.send(bytes, { binary });
      };
      client.on('error', () => {}); upstream.on('error', () => client.close(1011, 'Session host disconnected'));
      client.once('close', () => upstream.terminate()); upstream.once('close', () => client.close());
      upstream.on('message', (bytes, binary) => send(client, bytes, binary));
      client.on('message', (bytes, binary) => {
        chain = chain.then(async () => {
          await opened;
          if (target.pathname === '/events') {
            const data = JSON.parse(bytes);
            if (data.type === 'desktop-register') {
              const state = await refresh();
              /* Filtered here as well as in `Desktops`, because this is the layer a live workspace can
                 be given: `update_workspace` puts a current worker above a host that still refuses the
                 frame, and a desktop restoring a replaced host's layout has to register through it
                 (spec 098). The ids removed here travel to the desktop in the registered frame. */
              const { frame, dropped } = withoutEndedSessions(data, state);
              try { desktops.register(client, frame, { dropped }); }
              catch (error) { registerError = { at: Date.now(), message: error.message }; throw error; }
              registerError = null;
              for (const rootId of desktops.clients.get(client)?.rootIds ?? []) { await follow(rootId); await pushToken(rootId, client); }
              return;
            }
            if (data.type === 'desktop-action-result') { desktops.acknowledge(client, data); return; }
            if (data.type === 'token-action') { await desktopToken(client, data); return; }
            if (data.type === 'recording') { await desktopRecording(client, data); return; }
          }
          send(upstream, bytes, binary);
        }).catch(error => send(client, JSON.stringify({ type: 'error', error: error.message })));
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
  await prime();
  subscribe();
  return { url, token, instance: host.instance, pid: process.pid, tokens, retire, get ide() { return ide; }, async close() {
    closing = true; hostStream?.terminate();
    await ide?.close?.();
    for (const entry of relays.values()) entry.socket?.terminate();
    relays.clear();
    for (const client of sockets.clients) client.terminate(); sockets.close();
    await tokens?.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}
if (process.send) {
  process.once('message', async message => {
    try {
      const worker = await startWorker(message.host, { directory: message.directory, idePort: message.idePort });
      process.send({ type: 'ready', url: worker.url, token: worker.token, instance: worker.instance, pid: process.pid });
      /* Serialized, because a worker that is drained the instant it is replaced is told both things
         at once and the handoff has to finish before the process goes away. */
      let queue = Promise.resolve();
      process.on('message', message => {
        queue = queue.then(async () => {
          if (message.type === 'retired') await worker.retire();
          else if (message.type === 'close') { await worker.close(); process.exit(0); }
        }).catch(() => {});
      });
      process.on('disconnect', async () => { await worker.close(); process.exit(0); });
    } catch (error) { process.send({ type: 'failed', error: error.message }); process.exitCode = 1; process.disconnect(); }
  });
}

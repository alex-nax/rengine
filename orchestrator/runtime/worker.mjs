import http from 'node:http';
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
import { runtimeDirectory, alive } from './discovery.mjs';
import { Tokens, readIdentity } from './token.mjs';

export async function startWorker(host, options = {}) {
  checkConnection(host);
  const state = await call(host, 'state');
  if (state.instance !== host.instance) fail('Session host identity changed.');
  let bindings = state, url;
  const token = randomBytes(32).toString('hex');
  const root = id => bindings.roots.find(x => x.id === id) ?? fail('Unknown project root.', 404);
  const snapshot = id => bindings.sessions.find(x => x.id === id) ?? fail('Unknown session.', 404);
  const desktops = new Desktops({ root }, { snapshot });
  const refresh = async () => { const state = await call(host, 'state'); if (state.instance !== host.instance) fail('Session host identity changed.'); bindings = state; return state; };
  /* Preflight runs here, from this checkout, exactly as the dashboard does; only the launch needs
     the retained host, which owns the PTY and the embedded surface. See sidecar: game-routes. */
  const preflight = (rootId, gameId) => inspectGame(root(rootId), gameId);
  /* The ledger is the only capability this worker advertises conditionally: a worker whose runtime
     directory it cannot own serves everything else and says agentToken nowhere, so the tools refuse
     by name instead of calling a worker that would pass every gate (spec 095, criterion 8). */
  let tokens = null, ledgerError = null;
  const directory = options.directory ?? runtimeDirectory(host);
  try { tokens = await Tokens.open(directory, { alive }); }
  catch (error) { ledgerError = error.message; }
  const capabilities = ({ projectGameLaunch, ...rest }) => ({ ...rest, desktopActions: 1, layeredUpdates: 1, scriptActions: 1,
    formatRegistry: 1, dashboard: 1, projectGame: 1, recordings: 1, projectDevices: 1, ...(tokens ? { agentToken: 1 } : {}),
    ...(rest.projectGame === 1 ? { projectGameLaunch: 1 } : {}) });
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
  const actor = who => who ? { kind: 'agent', agentId: who.agentId, label: who.label } : { kind: 'desktop' };
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
    if (!who || !tokens) return { who, by: actor(who) };
    const ledger = await tokens.ledger(rootId);
    await ledger.settle();
    ledger.seen(who);
    const refusal = ledger.refusal(who, tool);
    await ledger.persist();
    if (refusal) fail(refusal, 409);
    return { who, by: actor(who) };
  };
  const tokenStatus = async (rootId, req, tool) => {
    if (!tokens) fail(`This workspace worker does not serve the project token ledger: ${ledgerError ?? 'no runtime directory'}.`, 409);
    const who = readIdentity(req.headers);
    const ledger = await tokens.ledger(rootId);
    await ledger.settle();
    if (who) { ledger.seen(who); await ledger.persist(); }
    return { ...ledger.status(who), caller: who, refusal: ledger.refusal(who, tool), feed: feedUrl(rootId) };
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
  /* The pinned worker->desktop frame (spec 095, Native desktop): flat holder/contest/windowMs plus
     the sequence of the last token.* frame, pushed to every desktop bound to the root when it
     registers and after every transition, so the status-bar segment never polls. */
  const pushToken = async (rootId, only = null) => {
    if (!tokens) return;
    const message = JSON.stringify((await tokens.ledger(rootId)).segment());
    for (const desktop of desktops.clients.values()) {
      if (only && desktop.socket !== only) continue;
      if (desktop.rootIds?.includes(rootId) && desktop.socket.readyState === WebSocket.OPEN) desktop.socket.send(message);
    }
  };
  const desktopToken = async (client, data) => {
    const desktop = desktopOf(client);
    if (!desktop) fail('Register the desktop before sending token actions.', 409);
    if (!tokens) fail('This workspace worker does not serve the project token ledger.', 409);
    if (!desktop.rootIds.includes(data.rootId)) fail('That project is not bound to this desktop.', 403);
    const ledger = await tokens.ledger(data.rootId);
    await ledger.desktop(data.action, { contestId: data.contestId, desktopId: desktop.id, reason: data.reason });
    await pushToken(data.rootId);
  };
  /* The recorder lives in the desktop (spec 081), so a commit is announced by the desktop on the
     same socket it registers on. Stage 3 sends this frame; the shape is fixed here. */
  const desktopRecording = async (client, data) => {
    const desktop = desktopOf(client);
    if (!desktop) fail('Register the desktop before sending recording frames.', 409);
    if (!desktop.rootIds.includes(data.rootId)) fail('That project is not bound to this desktop.', 403);
    if (!['started', 'committed'].includes(data.event)) fail('A recording frame carries event started or committed.');
    await note(data.rootId, data.event === 'started' ? 'capture.started' : 'capture.committed', { kind: 'desktop', desktopId: desktop.id },
      { sessionId: data.sessionId ?? null, gameId: data.gameId ?? null, recordingId: data.recordingId ?? null,
        kind: data.kind === 'explicit' ? 'explicit' : 'ring', ...(data.at ? { startedAt: String(data.at).slice(0, 40) } : {}),
        ...(data.error ? { error: String(data.error).slice(0, 400) } : {}) });
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
    if (closing || !tokens) return;
    const remote = new URL('/events', host.url); remote.protocol = 'ws:'; remote.searchParams.set('token', host.token);
    hostStream = new WebSocket(remote);
    hostStream.on('error', () => {});
    hostStream.on('message', bytes => {
      let data; try { data = JSON.parse(bytes); } catch { return; }
      if (data?.type === 'session') void onSession(data.session).catch(() => {});
    });
    hostStream.once('close', () => { if (closing || retries++ > 20) return; setTimeout(subscribe, 250).unref?.(); });
  };

  const server = http.createServer(async (req, res) => {
    try {
      const target = new URL(req.url, 'http://127.0.0.1');
      if (target.pathname === '/health') { json(res, 200, { protocol: 1, instance: host.instance, worker: process.pid }); return; }
      if (!authenticated(req, token, url)) fail('Workspace authentication required.', 401);
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
        if (!who) fail('Only an identified agent can act on the token; this request carried no X-Rengine-Agent header.', 403);
        const ledger = await tokens.ledger(root(data.rootId).id);
        const result = data.action === 'contest' ? await ledger.contest(who, data.reason)
          : data.action === 'reject' ? await ledger.reject(who, data.reason)
          : data.action === 'release' ? await ledger.release(who)
          : fail('Choose contest, reject or release.');
        await pushToken(data.rootId);
        json(res, 200, { ...result, status: ledger.status(who) });
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
      } else if (req.method === 'POST' && target.pathname === '/api/update-workspace') {
        const data = await body(req); await refresh(); await announce();
        await gate(req, root(data.rootId).id, 'update_workspace');
        json(res, 202, await call(host, 'update-workspace', data));
      } else if (req.method === 'GET' && target.pathname === '/api/recordings') {
        await refresh(); json(res, 200, await listRecordings(root(target.searchParams.get('rootId')), Object.fromEntries(target.searchParams)));
      } else if (req.method === 'GET' && target.pathname === '/api/recording') {
        await refresh();
        json(res, 200, await readRecording(root(target.searchParams.get('rootId')), target.searchParams.get('id'), Object.fromEntries(target.searchParams)));
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
        json(res, 200, { desktops: [...desktops.clients.values()].map(({ socket, ...desktop }) => desktop) });
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
      client.once('close', unsubscribe);
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
              await refresh(); desktops.register(client, data);
              for (const rootId of desktops.clients.get(client)?.rootIds ?? []) await pushToken(rootId, client);
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
  return { url, token, instance: host.instance, pid: process.pid, tokens, async close() {
    closing = true; hostStream?.terminate();
    for (const client of sockets.clients) client.terminate(); sockets.close();
    await tokens?.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  } };
}
if (process.send) {
  process.once('message', async message => {
    try {
      const worker = await startWorker(message.host, { directory: message.directory });
      process.send({ type: 'ready', url: worker.url, token: worker.token, instance: worker.instance, pid: process.pid });
      process.on('message', async message => { if (message.type === 'close') { await worker.close(); process.exit(0); } });
      process.on('disconnect', async () => { await worker.close(); process.exit(0); });
    } catch (error) { process.send({ type: 'failed', error: error.message }); process.exitCode = 1; process.disconnect(); }
  });
}

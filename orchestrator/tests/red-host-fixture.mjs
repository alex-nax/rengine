/* A real `red-host`, with the shape `server/main.mjs`'s `startServer` had (F152, spec 129).
 *
 * The JS host was a module a spec could call: it returned `store` and `sessions` objects whose
 * methods reached straight into the process the spec shared. The host is a binary now, so those
 * methods are the routes they were always served by — except the SYNCHRONOUS ones, and they are the
 * reason this file exists rather than a search-and-replace.
 *
 * Ninety-one call sites read `sessions.snapshot(id, true).output` inside a polling loop. Making them
 * `await` would rewrite every loop; instead this keeps the same mirror the JS client kept, for the
 * same reason it kept one: subscribe to `/events`, attach to each pane as it appears, and answer
 * `snapshot`, `list`, `get` and `items` from what has arrived. The door replays a pane's whole
 * scrollback on attach, so the mirror is complete rather than "from when we looked".
 *
 * What a spec hands in changes spelling rather than meaning. `frontDoor` is gone — the door IS the
 * host — and `retainSessions` is what `close()` does with the panes.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { request } from './sidecar.mjs';

/* One call to a state-directory service (charter D60/D61, `red_core::service`): connect, attach with
   the protocol number, ask, and let go. A spec reaches for this only where a route does not exist —
   a service is the state directory's, and talking to it is what the host does on a spec's behalf
   everywhere else. */
async function service(directory, name, protocol, method, args) {
  const { createConnection } = await import('node:net');
  const descriptor = JSON.parse(await readFile(path.join(directory, `${name}.json`), 'utf8'));
  const port = Number(/^tcp:\/\/127\.0\.0\.1:(\d+)$/.exec(descriptor.url)?.[1]);
  const socket = createConnection({ host: '127.0.0.1', port });
  try {
    await once(socket, 'connect');
    let buffered = '';
    const answers = [];
    const waiting = [];
    socket.on('data', chunk => {
      buffered += chunk;
      let at;
      while ((at = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.id === undefined || value.id === null) continue;
        const waiter = waiting.shift();
        if (waiter) waiter(value); else answers.push(value);
      }
    });
    const ask = (id, named, params) => new Promise((resolve, reject) => {
      const held = answers.shift();
      if (held) { resolve(held); return; }
      waiting.push(value => (value.error ? reject(Object.assign(new Error(value.error.message), { status: value.error.status ?? undefined })) : resolve(value.result)));
      socket.write(`${JSON.stringify({ id, method: named, args: params })}\n`);
      setTimeout(() => reject(new Error(`the ${name} service did not answer ${named}`)), 10000);
    });
    await ask(1, 'attach', [{ token: descriptor.token, protocol }]);
    return await ask(2, method, args);
  } finally { socket.destroy(); }
}

export function redHostBinary() {
  return process.env.RENGINE_RED_HOST || path.resolve('red/target/debug/red-host');
}

/* `fail` as the JS host threw it: a message with a status on it, which specs match on. */
export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

export async function startServer({ stateDir, port = 0, retainSessions = false } = {}) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const child = spawn(redHostBinary(), ['--state', stateDir, ...(port ? ['--port', String(port)] : [])],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '', diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
  const announced = await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { said += chunk; if (said.includes('\n')) resolve(JSON.parse(said.split('\n')[0])); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`red-host exited ${code}: ${diagnostics}`)));
    setTimeout(() => reject(new Error(`red-host did not announce itself: ${diagnostics}`)), 60000);
  });
  /* The credential is in the descriptor, where a 0600 file is the right place for it and where
     `discoverSidecar` reads it. */
  const descriptor = JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8'));
  const instance = { url: announced.url, token: descriptor.token, instance: announced.instance };

  /* The mirror. One socket, attached to every pane it learns about, so the synchronous reads below
     answer from what the door has said rather than from a fetch a caller cannot await. */
  const items = new Map();
  const outputs = new Map();
  const socket = new WebSocket(`${instance.url.replace('http', 'ws')}/events?token=${instance.token}`);
  socket.on('error', () => {});
  const learn = session => {
    if (!session?.id) return;
    const kept = items.get(session.id);
    items.set(session.id, { ...kept, ...session });
    if (!kept && session.state === 'running' && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'attach', id: session.id }));
    }
  };
  socket.on('message', bytes => {
    let frame; try { frame = JSON.parse(bytes); } catch { return; }
    if (frame.type === 'session') learn(frame.session);
    else if (frame.type === 'attached') { learn(frame.session); outputs.set(frame.session.id, frame.session.output ?? ''); }
    else if (frame.type === 'output') {
      outputs.set(frame.id, `${outputs.get(frame.id) ?? ''}${frame.data}`);
      const held = items.get(frame.id);
      if (held) held.sequence = frame.sequence;
    }
  });
  await once(socket, 'open');
  /* What the directory's services are already holding, before anything is asked: a pane whose host
     was replaced is in the first list a caller reads, not one refresh later. */
  const opening = await request(instance, 'state');
  for (const session of opening.sessions ?? []) learn(session);

  const call = (route, body) => request(instance, route, body);
  const query = fields => new URLSearchParams(Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== null))).toString();

  const sessions = {
    get items() { return { get size() { return items.size; }, get: id => items.get(id), has: id => items.has(id), keys: () => items.keys(), values: () => items.values() }; },
    /* `get` carries the scrollback where `snapshot` asks for it, because the JS item did: a caller
       polling `get(id).output` is the commonest shape in this suite. */
    get(id) {
      const held = items.get(id);
      if (!held) fail('Unknown session.', 404);
      return { ...held, output: outputs.get(id) ?? '' };
    },
    snapshot(id, includeOutput = false) {
      const held = sessions.get(id);
      return includeOutput ? { ...held, output: outputs.get(id) ?? '' } : { ...held };
    },
    list() { return [...items.keys()].map(id => sessions.snapshot(id)); },
    async terminal(options) {
      const started = await call('terminal', options);
      /* Seeded from the answer rather than waited for on the socket: a caller that starts a pane and
         reads it in the next line must not race its own announcement. */
      learn(started);
      return started;
    },
    async stop(id) { const answer = await call('stop', { id }); learn({ ...items.get(id), ...answer }); return answer; },
    input: (id, data) => call('input', { id, data }),
    resize: (id, cols, rows) => call('resize', { id, cols, rows }),
    async restart(options) { const answer = await call('agent-restart', options); learn(answer); return answer; },
    restartAgent(id) { return sessions.restart({ id }); },
    /* What `startServer` used to give a spec for tearing a host down. */
    shutdown() { return undefined; },
    /* A pane's native view has appeared. On the socket, because that is where the door takes it —
       and awaited until the RECORD says so, because the caller's next line is usually about what
       the release made possible. */
    async presented(id) {
      socket.send(JSON.stringify({ type: 'presented', id }));
      for (let waited = 0; waited < 5000; waited += 25) {
        const held = await call(`session?${query({ id })}`).catch(() => null);
        if (held && held.waitingForView === undefined) return held;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      fail('The pane never reported its view as presented.', 409);
    },
  };

  const store = {
    directory: stateDir,
    addRoot: (rootPath, declarationFile) => call('roots', { path: rootPath, ...(declarationFile ? { declarationFile } : {}) }),
    async root(id) {
      const found = (await call('state')).roots.find(entry => entry.id === id);
      if (!found) fail('Unknown project root.', 404);
      return found;
    },
    readText: (rootId, relative) => call(`file?${query({ rootId, path: relative })}`),
    list: (rootId, relative = '', hidden = false) => call(`tree?${query({ rootId, path: relative, hidden })}`),
    saveText: (rootId, relative, text, version) => call('save', { rootId, path: relative, text, version }),
    putDraft: (rootId, relative, text) => call('draft', { rootId, path: relative, text }),
    discardDraft: (rootId, relative) => call('discard', { rootId, path: relative }),
    preferences: value => call('preferences', value),
    saveLayout: layout => call('layout', { layout }),
    /* The one store method with no route of its own: a conversation is RECORDED by a pane reporting
       it (`POST /api/agent-conversation`), and a spec that wants one already there has nothing to
       report from. It speaks to the directory's store service, which is what red-host does. */
    recordConversation: (rootId, entry) => service(stateDir, 'store', 1, 'recordConversation', [rootId, entry]),
    /* The store's own per-root list, read off the state the way the JS store read it off its own:
       `state.conversations` is keyed by root, and a root with none has none rather than nothing. */
    async listConversations(rootId) {
      const all = (await call('state')).conversations;
      if (!all || typeof all !== 'object' || Array.isArray(all)) return [];
      return (all[rootId] ?? []).map(entry => ({ ...entry }));
    },
  };

  return {
    ...instance, child, diagnostics: () => diagnostics, store, sessions,
    /* The whole state, which the JS host exposed as a synchronous `store.state`. It is a route now,
       because there is no shared process to read it out of. */
    state: () => call('state'),
    adopted: opening.sessions ?? [],
    async close({ retain = retainSessions } = {}) {
      try { socket.close(); } catch { /* already gone */ }
      /* Panes belong to the state directory's PTY service and outlive any host (charter D60), so
         ending them is an explicit act rather than a consequence of the host going. */
      if (!retain) {
        for (const id of [...items.keys()]) {
          if (items.get(id)?.state === 'running') await call('stop', { id }).catch(() => {});
        }
      }
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise(resolve => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000))]);
      }
    },
  };
}

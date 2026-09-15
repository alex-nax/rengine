/* A real `red-worker`, with the shape `runtime/worker.mjs`'s `startWorker` had (F158, spec 129).
 *
 * The specs below this were written against the JavaScript worker as a MODULE: start one, get back
 * a `{ url, token }` to call and a `close()`. The worker is a process now, so this is that shape
 * over a process — and the specs keep asking the same questions of the thing that answers them,
 * which is the point of porting rather than rewriting.
 *
 * `--no-ide` by default, and it matters: a published bridge writes a lock into the `/ide` menu of
 * whoever is running the suite. A spec that wants one asks, into a directory of its own.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeDirectory } from '../runtime/discovery.mjs';
import { built } from './cargo.mjs';

const BIN = process.env.RENGINE_RED_WORKER
  || fileURLToPath(new URL('../../red/target/debug/red-worker', import.meta.url));

export async function startWorker(host, { directory, ide = false, idePort = 0, env = {}, ideOptions } = {}) {
  await built('-p', 'red-worker', '--bin', 'red-worker');
  /* The same default `startWorker` had: this workspace's own runtime directory. A caller that named
     none used to get one, and a fixture that handed the binary the word `undefined` instead wrote a
     directory of that name wherever the suite was run from. */
  directory ??= runtimeDirectory(host);
  /* `ideOptions` is how `worker.mjs` was asked for a bridge into a directory of the test's own. The
     binary reads that directory from the environment, which is the same ask spelled for a process. */
  if (ideOptions?.directory) {
    ide = true;
    env = { ...env, RENGINE_IDE_DIRECTORY: ideOptions.directory };
  }
  const child = spawn(BIN, ['--state', directory, '--host', host.url, '--host-token', host.token,
    '--ide-port', String(idePort), ...(ide ? [] : ['--no-ide'])],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let noise = '';
  child.stderr.on('data', bytes => { noise = (noise + bytes).slice(-4000); });
  const line = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`red-worker did not announce itself: ${noise}`)), 30000);
    timer.unref?.();
    child.stdout.on('data', chunk => {
      text += chunk;
      if (text.includes('\n')) { clearTimeout(timer); resolve(text.split('\n')[0]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`red-worker exited (${code}): ${noise}`)); });
  });
  const announced = JSON.parse(line);
  return {
    ...announced,
    /* What `startIdeBridge` handed back, read from the lock the bridge published — which is the
       same file Claude Code reads, so a test that connects through this connects the way a CLI
       does. `null` when none was asked for. */
    ide: ide && ideOptions?.directory ? await published(ideOptions.directory) : null,
    instance: announced.instance ?? host.instance,
    child,
    get noise() { return noise; },
    /* Told down stdin, as the supervisor tells it: control of the PROCESS rather than of the
       workspace. Ending stdin is how a supervisor going away reads. */
    tell: message => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`); },
    retire: async () => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: 'retired' })}\n`); },
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: 'close' })}\n`);
      await new Promise(resolve => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 5000);
        timer.unref?.();
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

/** The editor this worker published, as `startIdeBridge` described one. */
async function published(directory, timeout = 20000) {
  const { readdir, readFile } = await import('node:fs/promises');
  for (let waited = 0; waited < timeout; waited += 50) {
    const found = (await readdir(directory).catch(() => [])).filter(name => name.endsWith('.lock'));
    if (found.length) {
      const lock = path.join(directory, found[0]);
      const said = JSON.parse(await readFile(lock, 'utf8'));
      return { published: true, lock, port: Number(path.basename(found[0], '.lock')), authToken: said.authToken };
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { published: false, reason: `no editor was published into ${directory}` };
}

/* A `desktop-register` frame, minus the sessions this host state does not have. Those ended with the
   host the desktop's saved layout was written under (spec 098); a malformed frame is left exactly as
   it arrived so the registry refuses it by name.
 *
 * Kept here because it is a RULE with its own spec, and `red-host` applies the same one: the Rust
 * side reports an unknown session back rather than refusing the frame, which is this shape read from
 * the other end. */
export function withoutEndedSessions(data, state) {
  if (!Array.isArray(data.sessionIds)) return { frame: data, dropped: [] };
  const live = new Set((state?.sessions ?? []).map(session => session.id));
  const dropped = data.sessionIds.filter(id => !live.has(id));
  return dropped.length
    ? { frame: { ...data, sessionIds: data.sessionIds.filter(id => live.has(id)) }, dropped }
    : { frame: data, dropped: [] };
}

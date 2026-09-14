/* A client of `red-ide serve` for the specs that judge it: the same stdio conversation `ide.mjs`
 * holds with it, without the module — so the parity test drives the binary and not the client that
 * will stand in front of it. */
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../red/target/debug/red-ide');

/** One `red-ide serve`: requests down, answers and asks up, the asks answered from `source`. */
export function serve(source, env = process.env) {
  const child = spawn(BINARY, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'], env });
  const pending = new Map();
  const events = [];
  const waitingForEvent = [];
  let sequence = 0, started;
  const ready = new Promise(resolve => { started = resolve; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.started) { started(); return; }
    if (message.ask !== undefined) {
      Promise.resolve().then(async () => {
        try { const result = await source?.(...message.args); child.stdin.write(`${JSON.stringify({ answer: message.ask, result })}\n`); }
        catch (error) { child.stdin.write(`${JSON.stringify({ answer: message.ask, error: { message: error.message } })}\n`); }
      });
      return;
    }
    if (message.event) { const waiter = waitingForEvent.shift(); waiter ? waiter(message) : events.push(message); return; }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result);
  });
  child.once('exit', () => { for (const waiting of pending.values()) waiting.reject(new Error('red-ide serve exited.')); pending.clear(); });
  const call = (method, args = []) => {
    const id = ++sequence;
    const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
    return answer;
  };
  const nextEvent = () => new Promise(resolve => { events.length ? resolve(events.shift()) : waitingForEvent.push(resolve); });
  const end = () => new Promise(resolve => { if (child.exitCode !== null) { resolve(); return; } child.once('exit', resolve); child.stdin.end(); });
  return { ready, call, nextEvent, end, child };
}

/* The harness the corpus drives: a bridge is one `red-ide serve` process, exactly as it is one per
   worker; `ready` is settled by the event the process sends when a retake settles. */
export async function rustHarness() {
  const processes = [];
  return {
    async start(options, source) {
      const service = serve(source);
      processes.push(service);
      await service.ready;
      let answer;
      try { answer = await service.call('start', [{ ...options, diagnostics: source !== null && source !== undefined }]); }
      catch (error) { await service.end(); throw error; }
      const handle = {
        published: answer.published, reason: answer.reason, port: answer.port, lock: answer.lock, authToken: answer.authToken ?? undefined,
        ready: null,
        selection: value => service.call('selection', [value]),
        mention: value => service.call('mention', [value]),
        clients: () => service.call('clients'),
        observed: () => service.call('observed'),
        async close() { await service.call('close').catch(() => {}); },
      };
      if (answer.published) handle.ready = Promise.resolve(true);
      else if (answer.reason && /still held/.test(answer.reason)) {
        handle.ready = service.nextEvent().then(event => {
          if (event.event === 'published') { handle.published = true; handle.port = event.port; handle.lock = event.lock; handle.reason = null; return true; }
          handle.reason = event.reason; return false;
        });
      } else handle.ready = Promise.resolve(false);
      return handle;
    },
    async sweep(directory) {
      const service = serve(null);
      processes.push(service);
      await service.ready;
      try { return await service.call('sweep', [directory]); } finally { await service.end(); }
    },
    async directory(env) {
      const { stdout } = await promisify(execFile)(BINARY, ['directory'], { env: { PATH: process.env.PATH, ...env } });
      return JSON.parse(stdout);
    },
    async finish() { for (const service of processes) await service.end(); },
  };
}

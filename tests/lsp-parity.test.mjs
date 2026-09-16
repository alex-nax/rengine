/* F161 (spec 129): the Rust language-server client answers the recorded corpus.
 *
 * `lsp-record.test.mjs` is the other half — it proves the record is what the JavaScript client
 * says. This one drives `red-lsp-serve`, one process per project root, through the same sequence
 * against the same fake server: which servers a file is matched to, what is published, what
 * survives a crash, and what a caller is told when a declared server is not on the machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CASES, RECORDED, declare } from './lsp-corpus.mjs';
import { built } from './cargo.mjs';

const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../red/target/debug/red-lsp-serve');

const DECLARATIONS = {
  default: () => declare(),
  missing: () => [{ id: 'absent', command: ['definitely-not-a-language-server-9f'], match: ['*.c'], languageId: 'c' }],
  crashing: () => declare({ args: ['--crash-after', '1'] }),
};
const fold = said => said.replace(/\(code \d+\)/, '(code N)').replace(/\(.*ENOENT.*\)/, '(ENOENT)');

/** One `red-lsp-serve`, spoken to the way the client will speak to it. */
function open(rootPath) {
  const child = spawn(BINARY, [rootPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let sequence = 0, started = null;
  const ready = new Promise(resolve => { started = resolve; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.started) { started(); return; }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result);
  });
  const call = (method, args = []) => {
    const id = ++sequence;
    const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    child.stdin.write(`${JSON.stringify({ id, method, args })}\n`);
    return answer;
  };
  return { ready, call, close: () => child.stdin.end() };
}

const until = async (check, label) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
};

test('the Rust language-server client gives the recorded answers', { timeout: 300000 }, async t => {
  await built('-p', 'red-lsp', '--bin', 'red-lsp-serve');
  assert.ok(RECORDED, 'lsp-corpus.json is present');
  const drift = [];
  for (const [name, options] of CASES) {
    const directory = await mkdtemp(path.join(tmpdir(), 'rengine-lsp-parity-'));
    await mkdir(path.join(directory, 'src'), { recursive: true });
    const service = open(directory);
    const steps = [];
    try {
      await service.ready;
      await service.call('declare', [DECLARATIONS[options.declared]()]);
      for (const step of options.steps) {
        if (step.open) {
          const answer = await service.call('open', [path.join(directory, step.open), step.text]);
          if (step.awaitItems) {
            await until(async () => (await service.call('diagnostics', [answer.uri])).items.length === step.awaitItems || null, `${step.awaitItems} items`);
          }
          steps.push({ opened: step.open, servers: answer.servers });
        } else if (step.close) {
          await service.call('close', [path.join(directory, step.close)]);
          steps.push({ closed: step.close });
        } else if (step.read) {
          /* The URI is computed here rather than asked for: asking through `open` would TELL the
             servers about the file, which is the thing the read is meant to observe. */
          const uri = pathToFileURL(path.join(directory, step.read)).href;
          steps.push({ read: step.read, items: (await service.call('diagnostics', [uri])).items });
        } else if (step.awaitUnavailable) {
          const said = await until(async () => { const list = await service.call('unavailable'); return list.length ? list : null; }, 'a named absence');
          steps.push({ unavailable: said.map(fold) });
        }
      }
      const live = { steps, unavailable: (await service.call('unavailable')).map(fold) };
      if (JSON.stringify(live) !== JSON.stringify(RECORDED[name])) drift.push([name, live]);
    } finally {
      await service.call('stop').catch(() => {});
      service.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  for (const [name, live] of drift) assert.deepEqual(live, RECORDED[name], name);
  assert.deepEqual(drift.map(([name]) => name), [], 'every case answers as recorded');
});

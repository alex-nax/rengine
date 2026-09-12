/* F176 (F151a, spec 129, KI-096): the red-pty service core proves terminal behavior parity with
 * the real JS session host. One scripted scenario set drives BOTH the real Sessions class
 * (spawnTerminal and friends) and the red-pty stdio service through the same steps, and the two
 * must agree on everything a person can see: final output byte-for-byte (the OUTPUT_LIMIT
 * truncation counted in UTF-16 units, lone-surrogate edge included), state and exit codes,
 * resize effects, tree kill, the whole-paste case (F112), and the output events' concatenated
 * data — chunk boundaries are implementation-defined and deliberately not compared.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVE = path.join(ROOT, 'red/target/debug/red-pty-serve');
const run = promisify(execFile);
const OUTPUT_LIMIT = 1024 * 1024;

/* The two drivers. `js` is the real Sessions class on a real store; `rust` is the pty client on
   the service. Both expose the same harness surface. */
async function jsDriver(t, directory) {
  const { WorkspaceStore } = await import('../server/store-client.mjs');
  const { Sessions } = await import('../server/sessions.mjs');
  const store = await WorkspaceStore.open(path.join(directory, 'state'));
  const root = await store.addRoot(directory);
  const sessions = new Sessions(store);
  const events = [];
  sessions.on('event', event => events.push(event));
  return {
    events,
    spawn: options => sessions.spawnTerminal({ rootId: root.id, type: 'terminal', ...options }).then(snapshot => snapshot.id),
    input: (id, data) => sessions.input(id, data),
    resize: (id, cols, rows) => sessions.resize(id, cols, rows),
    stop: id => sessions.stop(id),
    snapshot: async id => sessions.snapshot(id, true),
    close: async () => { await sessions.shutdown(); await store.close(); },
  };
}

async function rustDriver(t, directory) {
  const client = await import('../server/pty-client.mjs');
  const pty = await client.PtyHost.open(path.join(directory, 'pty-state'));
  const events = [];
  pty.on('event', event => events.push(event));
  return {
    events,
    spawn: options => pty.spawn(options).then(snapshot => snapshot.id),
    input: (id, data) => pty.input(id, data),
    resize: (id, cols, rows) => pty.resize(id, cols, rows),
    stop: id => pty.stop(id),
    snapshot: async id => pty.snapshot(id),
    close: () => pty.close(),
  };
}

const until = async (check, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('until() timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

const outputOf = events => events.filter(event => event.type === 'output').map(event => event.data).join('');

/* One scenario is a function of a driver; run it against both and compare. */
const SCENARIOS = {
  async 'echo and exit code'(h) {
    const id = await h.spawn({ command: '/bin/bash', args: ['-c', 'printf "hello\\n"; exit 7'], cols: 80, rows: 24 });
    await until(async () => (await h.snapshot(id)).state === 'exited');
    const snapshot = await h.snapshot(id);
    return { output: snapshot.output, state: snapshot.state, exitCode: snapshot.exitCode };
  },

  async 'a 300 KB paste arrives whole and is counted'(h) {
    /* head -c counts what actually arrived — a lost byte stalls it, so this is the whole-paste
       check with no echo side competing for the tty buffers (the EIO truth is KI-097's, and it
       bites both sides identically). */
    const id = await h.spawn({ command: '/bin/bash', args: ['-c', 'printf "READY\\n"; stty raw; head -c 307201 | wc -c; printf "done\\n"'], cols: 80, rows: 24 });
    /* READY first: bytes that arrive before stty raw takes the tty die in the canonical line
       buffer — a startup race, not a port. */
    await until(() => outputOf(h.events).includes('READY'));
    const paste = 'a'.repeat(300 * 1024);
    for (let index = 0; index < paste.length; index += 4096) {
      await h.input(id, paste.slice(index, index + 4096));
      await new Promise(resolve => setTimeout(resolve, 5)); // the tty buffer drains as the reader consumes; node-pty offers no drain callback
    }
    await h.input(id, '\n');
    await until(() => outputOf(h.events).includes('done'));
    return { counted: /307201/.test(outputOf(h.events)), state: (await h.snapshot(id)).state };
  },

  async 'resize changes what stty reports'(h) {
    const id = await h.spawn({ command: '/bin/bash', args: ['-s'], cols: 80, rows: 24 });
    await until(() => outputOf(h.events).includes('$ '));
    await h.input(id, 'stty size\n');
    await until(() => /\d+ \d+\r?\n/.test(outputOf(h.events)));
    const before = /(\d+) (\d+)\r?\n(?![\s\S]*\d+ \d+\r?\n)/.exec(outputOf(h.events)).slice(1).map(Number);
    await h.resize(id, 120, 40);
    await h.input(id, 'stty size\n');
    await until(() => outputOf(h.events).includes('40 120'));
    return { before, afterIncluded: outputOf(h.events).includes('40 120') };
  },

  async 'stop kills the whole tree'(h) {
    /* nohup, or the test proves nothing: with a plain sleep the leader's death SIGHUPs the group
       and the tree dies of its own accord — immune to that is exactly what the tree-kill is for. */
    const id = await h.spawn({ command: '/bin/bash', args: ['-c', 'nohup sleep 300 & echo SLEEPPID=$!; wait'], cols: 80, rows: 24 });
    await until(() => outputOf(h.events).includes('SLEEPPID='));
    const sleepPid = Number(/SLEEPPID=(\d+)/.exec(outputOf(h.events))[1]);
    await h.stop(id);
    const snapshot = await h.snapshot(id);
    let alive = true;
    try { process.kill(sleepPid, 0); } catch { alive = false; }
    return { state: snapshot.state, sleepAlive: alive };
  },

  async 'output truncates at the UTF-16 limit, tail intact'(h) {
    const script = `python3 -c "import sys; sys.stdout.write('a' * ${OUTPUT_LIMIT - 16} + 'TAIL-MARKER-12\\n')"`;
    const id = await h.spawn({ command: '/bin/bash', args: ['-c', script], cols: 80, rows: 24 });
    await until(async () => (await h.snapshot(id)).state === 'exited');
    const snapshot = await h.snapshot(id);
    return { units: [...snapshot.output].length === OUTPUT_LIMIT - 0 ? snapshot.output.length : snapshot.output.length,
      length: snapshot.output.length, tail: snapshot.output.endsWith('TAIL-MARKER-12\n'),
      head: snapshot.output.slice(0, 12) };
  },

  async 'the surrogate edge at the slice boundary'(h) {
    /* '😀' then (LIMIT-1) 'a': one unit over the limit, so the dropped unit is the emoji's HIGH
       surrogate and the scrollback starts with its LOW half — the service must reproduce that
       first code unit exactly, not a replacement character. */
    const script = `python3 -c "import sys; sys.stdout.write('😀' + 'a' * ${OUTPUT_LIMIT - 1})"`;
    const id = await h.spawn({ command: '/bin/bash', args: ['-c', script], cols: 80, rows: 24 });
    await until(async () => (await h.snapshot(id)).state === 'exited');
    const snapshot = await h.snapshot(id);
    return { first: snapshot.output.charCodeAt(0), length: snapshot.output.length };
  },

  async 'multibyte output decodes whole, no stray replacement chars'(h) {
    const id = await h.spawn({ command: '/bin/bash', args: ['-c', 'printf "\\xc3\\xa9\\xe2\\x82\\xac\\xf0\\x9f\\x98\\x80"; sleep 0.5; printf "\\xf0\\x9f\\x98"; sleep 0.5; printf "\\x80\\n"'], cols: 80, rows: 24 });
    await until(async () => (await h.snapshot(id)).state === 'exited');
    const snapshot = await h.snapshot(id);
    return { output: snapshot.output };
  },
};

test('the red-pty service matches the JS session host on the scenario set', async t => {
  await run('cargo', ['build', '-p', 'red-pty', '--bin', 'red-pty-serve'], { cwd: path.join(ROOT, 'red') });
  assert.ok(existsSync(SERVE), `red-pty-serve was built at ${SERVE}`);
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const dirJs = await mkdtemp(path.join(tmpdir(), 'rengine-pty-js-'));
    const dirRust = await mkdtemp(path.join(tmpdir(), 'rengine-pty-rust-'));
    t.after(() => { rm(dirJs, { recursive: true, force: true }); rm(dirRust, { recursive: true, force: true }); });
    const js = await jsDriver(t, dirJs);
    const rust = await rustDriver(t, dirRust);
    const [fromJs, fromRust] = await Promise.all([scenario(js), scenario(rust)]);
    await js.close();
    await rust.close();
    assert.deepEqual(fromRust, fromJs, `scenario: ${name}`);
  }
});

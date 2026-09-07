import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { LanguageServers, framer, uriFor } from '../runtime/lsp.mjs';

const SERVER = path.resolve('orchestrator/tests/fake-language-server.mjs');
const declare = (extra = {}) => [{ id: 'fake', command: [process.execPath, SERVER, ...(extra.args ?? [])],
  match: extra.match ?? ['*.c', 'src/**/*.c'], languageId: 'c' }];

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-lsp-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  return { id: 'r1', path: dir, name: 'project' };
}

const until = async (check, label) => {
  for (let i = 0; i < 120; i++) { const value = check(); if (value?.length) return value; await delay(50); }
  throw new Error(`Timed out: ${label}`);
};

test('the framer reads a message whose body contains the delimiter it would otherwise split on', () => {
  // A diagnostic message with a blank line in it is exactly the input that breaks a naive reader.
  const seen = [];
  const read = framer(message => seen.push(message));
  const body = JSON.stringify({ method: 'note', params: { text: 'first\r\n\r\nsecond' } });
  const bytes = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 'utf8');
  // Delivered a byte at a time, because a pipe is under no obligation to align with messages.
  for (const byte of bytes) read(Buffer.from([byte]));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].params.text, 'first\r\n\r\nsecond');
});

test('a declared server is started, told the buffer, and its diagnostics are what getDiagnostics reads', async () => {
  const root = await project();
  const servers = new LanguageServers(root, declare());
  try {
    const file = path.join(root.path, 'a.c');
    const { uri, servers: served } = await servers.open(file, 'int main(void) {\n  // TODO one\n  return 0;\n}\n');
    assert.deepEqual(served, ['fake'], 'the file is matched to its declared server');
    const items = await until(() => servers.for(uri), 'the server publishes');
    assert.equal(items.length, 1);
    assert.equal(items[0].message, 'TODO on line 2');
    assert.deepEqual(items[0].range.start, { line: 1, character: 5 });

    // The buffer is the truth, not the file: nothing was written to disk and the answer changed.
    await servers.open(file, '// TODO one\n// TODO two\n');
    const changed = await until(() => (servers.for(uri).length === 2 ? servers.for(uri) : null), 'the change is reflected');
    assert.deepEqual(changed.map(item => item.message), ['TODO on line 1', 'TODO on line 2']);

    // A file no server declares is nobody's business, and starts nothing.
    const other = await servers.open(path.join(root.path, 'notes.txt'), 'TODO');
    assert.deepEqual(other.servers, [], 'an unmatched file matches no server');
    assert.deepEqual(servers.for(other.uri), []);
  } finally { await servers.stop(); await rm(root.path, { recursive: true, force: true }); }
});

test('a declared server that is not on the machine is named, and the workspace keeps working', async () => {
  const root = await project();
  const servers = new LanguageServers(root, [{ id: 'missing', command: ['rengine-no-such-language-server'], match: ['*.c'] }]);
  try {
    const { uri } = await servers.open(path.join(root.path, 'a.c'), 'int main(void);\n');
    const reasons = await until(() => servers.unavailable(), 'the absence is reported');
    assert.match(reasons[0], /missing: rengine-no-such-language-server is not on this machine/);
    assert.match(reasons[0], /never installs one/, 'and says whose job it is not');
    assert.deepEqual(servers.for(uri), [], 'and no diagnostics are invented for it');
  } finally { await servers.stop(); await rm(root.path, { recursive: true, force: true }); }
});

test('a server that crashes is restarted, and its diagnostics do not outlive it', async () => {
  const root = await project();
  // Crashing on the *second* open, not the first: a server that publishes and dies in the same
  // millisecond leaves no window in which its answer was ever observable, so a test written that way
  // races itself rather than testing anything.
  const servers = new LanguageServers(root, declare({ args: ['--crash-after', '2'] }));
  try {
    const file = path.join(root.path, 'a.c');
    const { uri } = await servers.open(file, '// TODO here\n');
    const items = await until(() => servers.for(uri), 'the first answer arrives');
    assert.equal(items.length, 1);
    await servers.open(path.join(root.path, 'b.c'), '// TODO there\n');
    // The second open kills it. Its diagnostics must go with it: reporting a file as broken on the
    // word of a dead process is worse than reporting nothing.
    await until(() => (servers.for(uri).length === 0 ? ['cleared'] : null), 'the dead server\'s diagnostics are cleared');
    const reasons = await until(() => servers.unavailable(), 'the exit is reported');
    assert.match(reasons[0], /exited \(code 3\); restarting in \d+ ms/);
  } finally { await servers.stop(); await rm(root.path, { recursive: true, force: true }); }
});

test('closing a file tells the server and drops what it said', async () => {
  const root = await project();
  const servers = new LanguageServers(root, declare());
  try {
    const file = path.join(root.path, 'src', 'deep.c');
    await writeFile(file, '');
    const { uri, servers: served } = await servers.open(file, '// TODO nested\n');
    assert.deepEqual(served, ['fake'], 'a ** pattern matches a nested file');
    await until(() => servers.for(uri), 'published');
    servers.close(file);
    assert.deepEqual(servers.for(uri), [], 'a closed file has no diagnostics to report');
  } finally { await servers.stop(); await rm(root.path, { recursive: true, force: true }); }
});

/* The product's name is declared once and generated (charter D41, spec 108).
 *
 * This file is the ONE place in the shipping tree allowed to write the name out, and it is the file
 * `tools/design.py product` allowlists. That is deliberate. `IDE_NAME` is published into other
 * people's `/ide` menus beside VS Code and Cursor, so a rename should have to change a line that
 * says out loud that it is a published change — rather than two generated artifacts quietly agreeing
 * with each other while nobody notices the product renamed itself.
 *
 * Everything else here asks a consumer what it actually answers: the lock file a bridge publishes,
 * the bytes sent to a language server, the HTML a sign-in callback serves.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PRODUCT_NAME, PRODUCT_FAMILY } from '../runtime/product.mjs';
import { startIdeBridge, IDE_NAME } from '../runtime/ide.mjs';
import { LanguageServers } from './lsp-client.mjs';
import { built } from './cargo.mjs';

/* This spec drives a Rust binary through a service client, so it builds one first: run alone — or
   used to check that a regression fails for its own reason — it would otherwise judge whatever
   binary happened to be on disk, and a sabotage that is never compiled always passes. `npm test`
   prebuilds and this is a no-op there (orchestrator/tests/cargo.mjs). */
before(() => built('--bins'));


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const run = promisify(execFile);
const temporary = name => mkdtemp(path.join(tmpdir(), `rengine-${name}-`));

/* A language server that answers initialize and records who said hello. Written per test rather than
   added to the shared fake, because the only thing it is for is reading the bytes we send. */
const RECORDER = `import { writeFileSync } from 'node:fs';
const report = process.argv[2];
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (message.method !== 'initialize') continue;
    writeFileSync(report, JSON.stringify(message.params.clientInfo));
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }));
    process.stdout.write(\`Content-Length: \${body.length}\\r\\n\\r\\n\`);
    process.stdout.write(body);
  }
});
`;

test('the published name is the one the owner settled, and changing it is a published change', () => {
  // The only hand-written product name left in the shipping tree. If this line has to change, the
  // change is visible in `/ide` menus that are not ours: it is a release note, not a refactor.
  assert.equal(PRODUCT_NAME, 'rEdit');
  // Red is the family word rEdit produced; the business edition wears it as RED Suite, and an
  // edition supplies the editor's own name at run time (D42 revised, spec 109).
  assert.equal(PRODUCT_FAMILY, 'Red');
});

test('the generated artifacts carry the declaration rather than a copy of it', async () => {
  const declared = JSON.parse(await readFile(path.join(ROOT, 'orchestrator/native/theme.json'), 'utf8')).product;
  assert.equal(PRODUCT_NAME, declared.name, 'the JS module is generated from the declaration');
  assert.equal(PRODUCT_FAMILY, declared.family);

  // The C side of the same declaration. Asserted by reading the generated header, so a stale one is
  // caught here as well as by `python3 tools/design.py check`.
  const header = await readFile(path.join(ROOT, 'orchestrator/native/theme.h'), 'utf8');
  assert.match(header, /^#define RE_PRODUCT_NAME "(.*)"$/m);
  assert.equal(/^#define RE_PRODUCT_NAME "(.*)"$/m.exec(header)[1], declared.name,
    'theme.h names the declared product; app.h aliases RE_DEFAULT_TITLE to it');
  assert.equal(/^#define RE_PRODUCT_FAMILY "(.*)"$/m.exec(header)[1], declared.family);

  // A retired name is guarded like the current one, so a half-finished rename fails rather than
  // lingering in a corner nobody greps. The list is empty today and that is correct: rEdit was
  // briefly retired by D41 and is the entertainment editor's name again under D42 revised, so
  // nothing is actually gone. What must never happen is a live name sitting in it.
  assert.ok(Array.isArray(declared.retired), 'the retired list exists even when nothing is retired');
  assert.ok(!declared.retired.includes(declared.name), 'the current name is never retired');
  assert.ok(!declared.retired.includes(declared.family), 'nor is the family word');
});

test('the lock file other people read publishes the declared name', async () => {
  const directory = await temporary('ide-name');
  const bridge = await startIdeBridge({ roots: ['/work/one'], hostPid: 4242, workerPid: 99, directory });
  try {
    const lock = JSON.parse(await readFile(bridge.lock, 'utf8'));
    assert.equal(lock.ideName, PRODUCT_NAME, 'this is the word that appears in a person\'s /ide menu');
    // And the comparison auto-connect makes is against the same export, so a workspace cannot stop
    // recognising its own editor and silently decline to connect a pane (F103).
    assert.equal(IDE_NAME, PRODUCT_NAME);
  } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a language server is told the declared name', async () => {
  const directory = await temporary('lsp-name');
  const report = path.join(directory, 'client.json');
  const server = path.join(directory, 'recorder.mjs');
  await writeFile(server, RECORDER);
  await mkdir(path.join(directory, 'src'), { recursive: true });
  const servers = new LanguageServers({ id: 'r1', path: directory, name: 'project' },
    [{ id: 'recorder', command: [process.execPath, server, report], match: ['*.c'], languageId: 'c' }]);
  try {
    await servers.open(path.join(directory, 'a.c'), 'int main(void) { return 0; }\n');
    const client = JSON.parse(await readFile(report, 'utf8'));
    assert.equal(client.name, PRODUCT_NAME, 'what a server\'s log calls us');
  } finally { await servers.stop(); await rm(directory, { recursive: true, force: true }); }
});

/* The sign-in callback page wears the declared name too, and that assertion moved with the page:
 * `red_worker::signin`'s `the_page_wears_the_declared_name_a_person_came_from` holds it, because the
 * page is Rust's now (F154).
 */
test('no shipping source hard-codes the product name, and the guard says so when one does', async () => {
  // The real tree. Scoped to the name, so an unrelated colour literal in another lane's native edit
  // does not turn this red for something it is not about.
  // The rejection is caught rather than left to fail the test by its exit code: what a reader needs
  // is the file and line the guard found, not "command failed".
  const clean = await run(PYTHON, ['tools/design.py', 'product'], { cwd: ROOT }).catch(error => error);
  const report = JSON.parse(clean.stdout);
  assert.deepEqual(report.problems, [], 'a hand-written product name is in the shipping tree');
  assert.equal(report.name, PRODUCT_NAME);

  // And the guard goes red for its own reason. The decoy is written outside the tree because other
  // agents are working in it; `product PATH` scans what it is pointed at.
  const directory = await temporary('name-decoy');
  const decoy = path.join(directory, 'decoy.mjs');
  await writeFile(decoy, [
    '// A comment naming Red is prose and must not fire; a file has to be able to say what it is.',
    // The editor's own name as a string, and the family word as a regular expression: both are live
    // names under D42 revised, and a regex is not a string, which is what the guard missed at first.
    `export const NAME = '${report.name}';`,
    `export const MATCH = /^${report.family}\\b/;`,
    ''].join('\n'));
  try {
    await assert.rejects(() => run(PYTHON, ['tools/design.py', 'product', decoy], { cwd: ROOT }),
      error => {
        const found = JSON.parse(error.stdout).problems;
        assert.equal(found.length, 2, `the string and the regular expression, not the comment: ${found.join('; ')}`);
        assert.match(found[0], /decoy\.mjs:2: hard-coded product name/);
        assert.match(found[1], /decoy\.mjs:3: hard-coded product name/);
        return true;
      });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

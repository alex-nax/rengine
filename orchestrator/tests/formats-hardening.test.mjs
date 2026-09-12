import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../server/main.mjs';
import { request } from '../launcher/sidecar.mjs';
import { readDeclaration, runCommand } from '../server/formats.mjs';
import { validateSchema } from '../server/store-client.mjs';
import { producer, pack, declaration, entries, project } from './format-fixtures.mjs';

test('structurally broken declarations and prototype-named keys are reported, never thrown', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-formats-broken-')));
  try {
    const good = declaration();
    const shapes = {
      'formats-object': { ...good, formats: {} },
      'numeric-argv': { ...good, formats: [{ ...good.formats[0], preview: { kind: 'tree', command: ['x', 5, '${file}'] } }] },
      'null-format': { ...good, formats: [null] },
      'proto-key': { ...good, formats: [{ ...good.formats[0], toString: 1 }] },
      'proto-command-key': { ...good, formats: [{ ...good.formats[0], preview: { ...good.formats[0].preview, hasOwnProperty: true } }] },
    };
    for (const [label, value] of Object.entries(shapes)) {
      const root = path.join(directory, label); await mkdir(path.join(root, '.rengine'), { recursive: true });
      await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(value));
      const result = await readDeclaration(root);
      assert.equal(result.declared, true, label); assert.ok(result.error, label); assert.deepEqual(result.formats, [], label);
    }
    assert.ok((await validateSchema({ type: 'object', properties: { a: {} }, additionalProperties: false }, { toString: 1 })).some(e => /unknown key toString/.test(e)));
    assert.ok((await validateSchema({ type: 'object', required: ['constructor'] }, {})).some(e => /requires constructor/.test(e)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the runner re-validates ${file} against the root immediately before spawning', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-formats-revalidate-')));
  try {
    const rootPath = await project(directory, 'game'), foreign = path.join(directory, 'foreign'); await mkdir(foreign);
    await writeFile(path.join(foreign, 'outside.pack'), pack({ entries: {} }));
    await symlink(path.join(foreign, 'outside.pack'), path.join(rootPath, 'escape.pack'));
    const root = { id: 'r', path: rootPath }, spec = { ...declaration().formats[0].preview, timeoutMs: 4000, maxBytes: 65536 };
    await assert.rejects(runCommand(root, spec, { file: '../foreign/outside.pack' }), /outside/);
    await assert.rejects(runCommand(root, spec, { file: 'escape.pack' }), /outside/);
    await assert.rejects(runCommand(root, spec, { file: path.join(foreign, 'outside.pack') }), /relative/);
    const run = await runCommand(root, spec, { file: 'sample.pack' });
    assert.equal(run.argv.at(-1), path.join(rootPath, 'sample.pack')); assert.ok(JSON.parse(run.stdout.toString()).dirs.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('timeouts kill the whole process group, including a sleeping grandchild', { timeout: 20000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-formats-group-')));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const rootPath = await project(directory, 'game', { preview: { kind: 'tree', command: [process.execPath, producer, 'tree', '${file}'], timeoutMs: 500, maxBytes: 65536 } });
  await writeFile(path.join(rootPath, 'fork.pack'), pack({ entries: {}, grandchild: true, sleep: 30000 }));
  const root = await server.store.addRoot(rootPath);
  let message; try { await request(server, 'format-preview', { rootId: root.id, path: 'fork.pack' }); } catch (error) { message = error.message; }
  const pid = Number(/GRANDCHILD (\d+)/.exec(message)?.[1]);
  assert.ok(pid > 0, `timeout error names the grandchild: ${message}`);
  const alive = id => { try { process.kill(id, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  let survived = true;
  for (let i = 0; i < 40 && survived; i++) { survived = alive(pid); if (survived) await delay(50); }
  if (survived) { try { process.kill(pid, 'SIGKILL'); } catch { /* best effort */ } }
  assert.equal(survived, false, 'grandchild is gone after the timeout');
});

test('preview_file stays within its response budget, paginates wide levels and hides absolute paths', { timeout: 30000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-formats-budget-')));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  let client;
  t.after(async () => { await client?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  const rootPath = await project(directory, 'game', { preview: { kind: 'tree', command: [process.execPath, producer, 'tree', '${file}'], timeoutMs: 4000, maxBytes: 4194304 } });
  await writeFile(path.join(rootPath, 'wide.pack'), pack({ entries: {}, flat: 1000 }));
  const root = await server.store.addRoot(rootPath);
  const context = path.join(directory, 'context.json');
  await writeFile(context, JSON.stringify({ url: server.url, token: server.token, instance: server.instance, rootId: root.id }), { mode: 0o600 });
  client = new Client({ name: 'budget-proof', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('orchestrator/agents/mcp.mjs'), '--context', context], stderr: 'pipe' }));
  const call = async args => { const r = await client.callTool({ name: 'preview_file', arguments: args }); return { isError: r.isError === true, text: r.content[0].text, value: r.isError ? null : r.structuredContent ?? JSON.parse(r.content[0].text) }; };
  const schema = (await client.listTools()).tools.find(x => x.name === 'preview_file').inputSchema;
  assert.ok(schema.properties.offset && schema.properties.limit, 'tool schema exposes offset/limit');
  const first = await call({ path: 'wide.pack', dir: 'flat' });
  assert.equal(first.isError, false); assert.ok(first.text.length <= 32000, `budgeted: ${first.text.length}`);
  assert.ok(first.value.tree.files.length < 1000); assert.equal(first.value.tree.files[0].path, 'flat/file0000.txt');
  assert.equal(first.value.truncated, true); assert.equal(first.value.nextOffset, first.value.tree.files.length); assert.equal(first.value.totalFiles, 1000);
  const second = await call({ path: 'wide.pack', dir: 'flat', offset: first.value.nextOffset, limit: 5 });
  assert.deepEqual(second.value.tree.files.map(f => f.name), Array.from({ length: 5 }, (_, i) => `file${String(first.value.nextOffset + i).padStart(4, '0')}.txt`));
  assert.equal(second.value.offset, first.value.nextOffset); assert.equal(second.value.nextOffset, first.value.nextOffset + 5);
  const last = await call({ path: 'wide.pack', dir: 'flat', offset: 995, limit: 100 });
  assert.equal(last.value.tree.files.length, 5); assert.equal(last.value.truncated, false); assert.equal(last.value.nextOffset, undefined);
  const top = await call({ path: 'sample.pack' });
  assert.deepEqual(top.value.command, [process.execPath, producer, 'tree', 'sample.pack'], 'root-relative file, executable outside the root untouched');
  assert.ok(!JSON.stringify(top.value).includes(rootPath), 'no absolute root path in the tool result');
  const entry = await call({ path: 'sample.pack', entry: 'readme.txt' });
  assert.ok(!JSON.stringify(entry.value).includes(rootPath)); assert.equal(entry.value.command.at(-2), 'sample.pack');
  await writeFile(path.join(rootPath, '.rengine/project.json'), JSON.stringify(declaration({ preview: { kind: 'tree', command: ['tools/absent-producer', '${file}'] } })));
  const failure = await call({ path: 'sample.pack' });
  assert.equal(failure.isError, true); assert.match(failure.text, /<root>\/tools\/absent-producer/); assert.ok(!failure.text.includes(rootPath), failure.text);
});

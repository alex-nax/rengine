import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../server/main.mjs';
import { startRuntime } from '../runtime/supervisor.mjs';
import { request } from '../launcher/sidecar.mjs';
import { readDeclaration, matchFormat, MAX_RAW_WINDOW } from '../server/formats.mjs';

import { producer, pack, declaration, entries, project } from './format-fixtures.mjs';

test('declaration discovery reports malformed files visibly and never disables the root', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-formats-decl-')));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const bad = declaration();
  const cases = {
    'contract 2': { ...bad, contract: 2 }, 'no formats': { ...bad, formats: [] }, 'missing title': { ...bad, formats: [{ ...bad.formats[0], title: undefined }] },
    'default outside modes': { ...bad, formats: [{ ...bad.formats[0], default: 'text' }] },
    'shell argv[0]': { ...bad, formats: [{ ...bad.formats[0], preview: { kind: 'tree', command: ['node $(x)', '${file}'] } }] },
    'string command': { ...bad, formats: [{ ...bad.formats[0], preview: { kind: 'tree', command: 'node tree ${file}' } }] },
    'unknown placeholder': { ...bad, formats: [{ ...bad.formats[0], preview: { kind: 'tree', command: ['node', '${root}/${file}'] } }] },
    'entry without ${entry}': { ...bad, formats: [{ ...bad.formats[0], entry: { kind: 'bytes', command: ['node', '${file}'] } }] },
    'preview mode without command': { ...bad, formats: [{ ...bad.formats[0], preview: undefined }] },
    'unknown key': { ...bad, formats: [{ ...bad.formats[0], shell: true }] }, 'duplicate id': { ...bad, formats: [bad.formats[0], bad.formats[0]] },
    'bad bound': { ...bad, formats: [{ ...bad.formats[0], preview: { ...bad.formats[0].preview, timeoutMs: 0 } }] },
  };
  for (const [label, value] of Object.entries(cases)) {
    const root = path.join(directory, label.replaceAll(/[^a-z0-9]/g, '-')); await mkdir(path.join(root, '.rengine'), { recursive: true });
    await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(value));
    const result = await readDeclaration(root);
    assert.equal(result.declared, true, label); assert.ok(result.error, label); assert.deepEqual(result.formats, [], label);
  }
  const syntax = path.join(directory, 'syntax'); await mkdir(path.join(syntax, '.rengine'), { recursive: true });
  await writeFile(path.join(syntax, '.rengine/project.json'), '{ not json'); await writeFile(path.join(syntax, 'note.txt'), 'still editable\n');
  assert.match((await readDeclaration(syntax)).error, /JSON/);
  assert.deepEqual(await readDeclaration(path.join(directory, 'state')), { declared: false, formats: [] });
  const root = await server.store.addRoot(syntax);
  const listed = await request(server, `formats?${new URLSearchParams({ rootId: root.id })}`);
  assert.equal(listed.declared, true); assert.match(listed.error, /JSON/); assert.deepEqual(listed.formats, []);
  assert.equal((await request(server, `file?${new URLSearchParams({ rootId: root.id, path: 'note.txt' })}`)).text, 'still editable\n');
  assert.ok((await request(server, `tree?${new URLSearchParams({ rootId: root.id })}`)).entries.some(x => x.name === 'note.txt'));
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: 'note.txt' }), /JSON/);
  const good = await readDeclaration(await project(directory, 'good'));
  assert.equal(good.error, undefined); assert.equal(good.formats[0].preview.timeoutMs, 4000);
  const defaults = await readDeclaration(await project(directory, 'defaults', { preview: { kind: 'tree', command: ['x', '${file}'] } }));
  assert.equal(defaults.formats[0].preview.timeoutMs, 10000); assert.equal(defaults.formats[0].preview.maxBytes, 4194304);
  for (const name of ['NOLF.REZ', 'nolf.rez', 'Sample.PACK']) assert.equal(matchFormat([{ id: 'a', match: ['*.rez', '*.pack'] }], name)?.id, 'a', name);
  assert.equal(matchFormat([{ id: 'a', match: ['*.rez'] }], 't01s01.dat'), null);
  assert.equal(matchFormat([{ id: 'a', match: ['t0?s0[12].dat'] }], 'T01S02.DAT')?.id, 'a');
  assert.equal(matchFormat([{ id: 'a', match: ['*.rez'] }], 'dir.rez/file.txt'), null);
});

test('previews, entries and raw windows run declared commands inside the root boundary', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-formats-')));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const rootPath = await project(directory, 'game');
  await writeFile(path.join(rootPath, 'UPPER.PACK'), pack({ entries: { 'one.txt': 'x' } }));
  await writeFile(path.join(rootPath, 'blob.bin'), Buffer.from([0, 255, 10, 13, 65]));
  const foreign = path.join(directory, 'foreign'); await mkdir(foreign); await writeFile(path.join(foreign, 'outside.pack'), pack({ entries: {} }));
  await symlink(path.join(foreign, 'outside.pack'), path.join(rootPath, 'escape.pack'));
  const root = await server.store.addRoot(rootPath), other = await server.store.addRoot(foreign);
  const state = await request(server, 'state'); assert.equal(state.capabilities.formatRegistry, 1);
  const listed = await request(server, `formats?${new URLSearchParams({ rootId: root.id })}`);
  assert.equal(listed.declared, true); assert.equal(listed.project, 'fixture'); assert.equal(listed.formats[0].id, 'fixture-pack');
  assert.deepEqual(listed.formats[0].modes, ['raw', 'preview']); assert.equal(listed.formats[0].default, 'raw');
  assert.deepEqual(await request(server, `formats?${new URLSearchParams({ rootId: other.id })}`), { rootId: other.id, declared: false, formats: [] });
  const preview = await request(server, 'format-preview', { rootId: root.id, path: 'sample.pack' });
  assert.equal(preview.kind, 'tree'); assert.equal(preview.format, 'fixture-pack'); assert.equal(preview.title, 'Fixture pack');
  assert.deepEqual(preview.command, [process.execPath, producer, 'tree', path.join(rootPath, 'sample.pack')]);
  assert.ok(preview.durationMs >= 0); assert.ok(preview.bytes > 0);
  assert.deepEqual(Object.keys(preview.tree).sort(), ['dirs', 'files', 'name']);
  assert.deepEqual(preview.tree.dirs.map(x => x.name), ['Worlds']);
  assert.deepEqual(preview.tree.files.map(x => x.name), ['odd $(name).txt', 'readme.txt']);
  assert.deepEqual(Object.keys(preview.tree.files[1]).sort(), ['name', 'path', 'size'], 'extra producer keys are dropped');
  assert.equal(preview.tree.dirs[0].files[0].size, 6); assert.equal(preview.tree.dirs[0].dirs[0].files[0].path, 'Worlds/sub/model.abc');
  assert.equal((await request(server, 'format-preview', { rootId: root.id, path: 'UPPER.PACK' })).tree.files[0].name, 'one.txt', 'case-insensitive glob');
  const textEntry = await request(server, 'format-preview', { rootId: root.id, path: 'sample.pack', entry: 'readme.txt' });
  assert.equal(textEntry.kind, 'entry'); assert.equal(textEntry.entry, 'readme.txt'); assert.equal(textEntry.size, 11);
  assert.equal(textEntry.sha256, createHash('sha256').update('hello pack\n').digest('hex')); assert.equal(textEntry.text, 'hello pack\n');
  assert.equal(textEntry.window.hex, Buffer.from('hello pack\n').toString('hex')); assert.equal(textEntry.command.at(-1), 'readme.txt');
  const binaryEntry = await request(server, 'format-preview', { rootId: root.id, path: 'sample.pack', entry: 'Worlds/t01.dat' });
  assert.equal(binaryEntry.text, undefined); assert.equal(binaryEntry.size, 6); assert.deepEqual(binaryEntry.window, { offset: 0, length: 6, hex: '000102fffefd' });
  const paged = await request(server, 'format-preview', { rootId: root.id, path: 'sample.pack', entry: 'Worlds/t01.dat', offset: 4, length: 1 });
  assert.deepEqual(paged.window, { offset: 4, length: 1, hex: 'fe' }); assert.equal(paged.size, 6);
  const literal = await request(server, 'format-preview', { rootId: root.id, path: 'sample.pack', entry: 'odd $(name).txt' });
  assert.equal(literal.text, 'literal'); assert.equal(literal.command.at(-1), 'odd $(name).txt');
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: 'sample.pack', entry: 'Worlds/nope.dat' }), /exit 1.*no such entry: Worlds\/nope.dat/);
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: '../foreign/outside.pack' }), /outside/);
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: 'escape.pack' }), /outside/);
  await assert.rejects(request(server, 'format-preview', { rootId: other.id, path: 'outside.pack' }), /declare/);
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: 'blob.bin' }), /No registered format/);
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: 'sample.pack', formatId: 'other' }), /formatId/);
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: 'missing.pack' }), /ENOENT|no such/i);
  const raw = await request(server, `bytes?${new URLSearchParams({ rootId: root.id, path: 'blob.bin' })}`);
  assert.deepEqual({ size: raw.size, offset: raw.offset, length: raw.length, hex: raw.hex }, { size: 5, offset: 0, length: 5, hex: '00ff0a0d41' });
  assert.ok(raw.modified > 0); assert.equal(raw.path, 'blob.bin');
  await assert.rejects(request(server, `file?${new URLSearchParams({ rootId: root.id, path: 'blob.bin' })}`), /Binary file/);
  const window = await request(server, `bytes?${new URLSearchParams({ rootId: root.id, path: 'blob.bin', offset: 3, length: 999999 })}`);
  assert.deepEqual([window.offset, window.length, window.hex], [3, 2, '0d41']);
  const beyond = await request(server, `bytes?${new URLSearchParams({ rootId: root.id, path: 'blob.bin', offset: 50 })}`);
  assert.deepEqual([beyond.offset, beyond.length, beyond.hex], [50, 0, '']);
  await writeFile(path.join(rootPath, 'large.bin'), Buffer.alloc(MAX_RAW_WINDOW + 10, 7));
  const capped = await request(server, `bytes?${new URLSearchParams({ rootId: root.id, path: 'large.bin', offset: 0, length: MAX_RAW_WINDOW + 10 })}`);
  assert.equal(capped.length, MAX_RAW_WINDOW); assert.equal(capped.size, MAX_RAW_WINDOW + 10);
  await assert.rejects(request(server, `bytes?${new URLSearchParams({ rootId: root.id, path: '../foreign/outside.pack' })}`), /outside/);
  await assert.rejects(request(server, `bytes?${new URLSearchParams({ rootId: root.id, path: '.rengine' })}`), /regular file/);
  const text = await project(directory, 'text', { modes: ['preview', 'text'], default: 'preview', preview: { kind: 'text', command: [process.execPath, producer, 'text', '${file}'] }, entry: undefined });
  const textRoot = await server.store.addRoot(text);
  const shown = await request(server, 'format-preview', { rootId: textRoot.id, path: 'sample.pack' });
  assert.equal(shown.kind, 'text'); assert.match(shown.text, /\nWorlds\/sub\/model.abc\t9\n/); assert.equal(shown.tree, undefined);
  await assert.rejects(request(server, 'format-preview', { rootId: textRoot.id, path: 'sample.pack', entry: 'readme.txt' }), /entry command/);
  const relative = await project(directory, 'relative', { preview: { kind: 'tree', command: ['tools/pack.sh', '${file}'] } });
  await mkdir(path.join(relative, 'tools'));
  await writeFile(path.join(relative, 'tools/pack.sh'), `#!/bin/bash\n[ "$(pwd)" = "${relative}" ] || { echo "wrong cwd $(pwd)" >&2; exit 9; }\nexec "${process.execPath}" "${producer}" tree "$@"\n`);
  await chmod(path.join(relative, 'tools/pack.sh'), 0o755);
  const relativeRoot = await server.store.addRoot(relative);
  const viaScript = await request(server, 'format-preview', { rootId: relativeRoot.id, path: 'sample.pack' });
  assert.equal(viaScript.command[0], path.join(relative, 'tools/pack.sh')); assert.equal(viaScript.tree.dirs[0].name, 'Worlds');
  assert.deepEqual(server.store.state.drafts, {});
});

test('command bounds fail visibly with the first stderr line', { timeout: 20000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-formats-bounds-')));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const rootPath = await project(directory, 'bounds', { preview: { kind: 'tree', command: [process.execPath, producer, 'tree', '${file}'], timeoutMs: 700, maxBytes: 2048 } });
  await writeFile(path.join(rootPath, 'failing.pack'), pack({ entries: {}, fail: 'boom: archive is corrupt' }));
  await writeFile(path.join(rootPath, 'slow.pack'), pack({ entries: {}, sleep: 5000 }));
  await writeFile(path.join(rootPath, 'huge.pack'), pack({ entries: {}, bloat: 4096 }));
  await writeFile(path.join(rootPath, 'garbage.pack'), Buffer.from('PACK\0{"entries":{},"bloat":12}'));
  const root = await server.store.addRoot(rootPath);
  const started = Date.now();
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: 'failing.pack' }), error => error.message === 'Command failed (exit 2): boom: archive is corrupt');
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: 'slow.pack' }), /timed out after 700 ms/);
  assert.ok(Date.now() - started < 4000, 'timeout kills the child instead of waiting for it');
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: 'huge.pack' }), /exceeded 2048 bytes/);
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: 'garbage.pack' }), /not one JSON tree object/);
  await writeFile(path.join(rootPath, 'missing-exe.pack'), pack({ entries: {} }));
  await writeFile(path.join(rootPath, '.rengine/project.json'), JSON.stringify(declaration({ preview: { kind: 'tree', command: ['tools/absent-producer', '${file}'] } })));
  await assert.rejects(request(server, 'format-preview', { rootId: root.id, path: 'missing-exe.pack' }), /absent-producer/);
});

test('the replaceable worker and the MCP tool serve the registry through the identical command', { timeout: 30000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-formats-runtime-')));
  const host = await startServer({ stateDir: path.join(directory, 'host') });
  let runtime, client;
  t.after(async () => { await client?.close(); await runtime?.close(); await host.close(); await rm(directory, { recursive: true, force: true }); });
  const rootPath = await project(directory, 'game'); await writeFile(path.join(rootPath, 'plain.txt'), 'plain\n');
  const root = await host.store.addRoot(rootPath);
  runtime = await startRuntime({ host, directory: path.join(directory, 'runtime') });
  const state = await request(runtime, 'state'); assert.equal(state.capabilities.formatRegistry, 1);
  assert.equal((await request(runtime, `formats?${new URLSearchParams({ rootId: root.id })}`)).formats[0].id, 'fixture-pack');
  assert.equal((await request(runtime, 'format-preview', { rootId: root.id, path: 'sample.pack' })).tree.dirs[0].name, 'Worlds');
  assert.equal((await request(runtime, `bytes?${new URLSearchParams({ rootId: root.id, path: 'sample.pack', length: 5 })}`)).hex, '5041434b00');
  const context = path.join(directory, 'context.json');
  await writeFile(context, JSON.stringify({ url: host.url, token: host.token, instance: host.instance, rootId: root.id, runtimeDirectory: path.join(directory, 'runtime') }), { mode: 0o600 });
  client = new Client({ name: 'formats-proof', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('orchestrator/agents/mcp.mjs'), '--context', context], stderr: 'pipe' }));
  const tools = await client.listTools(); const tool = tools.tools.find(x => x.name === 'preview_file');
  assert.ok(tool, 'preview_file is discoverable'); assert.equal(tool.annotations.openWorldHint, true); assert.equal(tool.annotations.destructiveHint, false);
  const call = async args => { const result = await client.callTool({ name: 'preview_file', arguments: args }); return { isError: result.isError === true, value: result.isError ? null : result.structuredContent ?? JSON.parse(result.content[0].text), text: result.content[0].text }; };
  const top = await call({ path: 'sample.pack' });
  assert.equal(top.isError, false); assert.equal(top.value.kind, 'tree'); assert.deepEqual(top.value.tree.dirs.map(x => x.name), ['Worlds']);
  assert.deepEqual(top.value.tree.dirs[0].dirs, [{ name: 'sub', dirs: 0, files: 1 }], 'depth 1 summarises deeper directories');
  assert.equal(top.value.tree.files[1].name, 'readme.txt'); assert.equal(top.value.totalFiles, 4);
  const sub = await call({ path: 'sample.pack', dir: 'Worlds/sub' });
  assert.equal(sub.value.tree.name, 'sub'); assert.equal(sub.value.tree.files[0].path, 'Worlds/sub/model.abc');
  const deep = await call({ path: 'sample.pack', depth: 3 }); assert.equal(deep.value.tree.dirs[0].dirs[0].files[0].name, 'model.abc');
  assert.equal((await call({ path: 'sample.pack', dir: 'Nowhere' })).isError, true);
  const entry = await call({ path: 'sample.pack', entry: 'readme.txt' });
  assert.equal(entry.value.text, 'hello pack\n'); assert.equal(entry.value.size, 11); assert.match(entry.value.sha256, /^[0-9a-f]{64}$/); assert.equal(entry.value.window, undefined);
  const binary = await call({ path: 'sample.pack', entry: 'Worlds/t01.dat' });
  assert.equal(binary.value.text, undefined); assert.equal(binary.value.size, 6);
  assert.equal((await call({ path: 'plain.txt' })).isError, true); assert.equal((await call({ path: '../host/x.pack' })).isError, true);
  const failure = await call({ path: 'sample.pack', entry: 'gone' }); assert.equal(failure.isError, true); assert.match(failure.text, /no such entry: gone/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../server/main.mjs';
import { request } from '../launcher/sidecar.mjs';
import { readDeclaration } from '../server/formats.mjs';
import { declaration } from './format-fixtures.mjs';
import { game, gameDeclaration, gameProject } from './game-fixtures.mjs';

const declare = async (directory, name, document) => {
  const root = path.join(directory, name); await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document)); return readDeclaration(root);
};
const waitOutput = async (server, id, text) => { for (let i = 0; i < 100; i++) { if (server.sessions.snapshot(id, true).output.includes(text)) return; await delay(50); } throw new Error(`session never printed ${text}`); };
const waitExit = async (server, id) => { for (let i = 0; i < 150 && server.sessions.snapshot(id).state !== 'exited'; i++) await delay(20); return server.sessions.snapshot(id).state; };

test('contract 2 game declarations validate, contract 1 stays accepted and game errors are named and isolated', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-game-decl-')));
  try {
    const one = await declare(directory, 'one', declaration()); assert.equal(one.contract, 1); assert.equal(one.error, undefined); assert.equal(one.game, undefined); assert.equal(one.gameError, undefined);
    const plain = await declare(directory, 'plain', { ...declaration(), contract: 2 }); assert.equal(plain.contract, 2); assert.equal(plain.game, undefined); assert.equal(plain.gameError, undefined);
    const full = await declare(directory, 'full', gameDeclaration());
    assert.equal(full.error, undefined); assert.equal(full.gameError, undefined); assert.deepEqual(full.game, game()); assert.equal(full.formats[0].id, 'fixture-pack');
    const minimal = await declare(directory, 'minimal', gameDeclaration({ args: undefined, env: undefined, requires: undefined }));
    assert.equal(minimal.gameError, undefined); assert.deepEqual(minimal.game, { id: 'fixture-game', title: 'Fixture game', executable: ['build/missing-game', 'tools/game.sh'], surface: 'external' });
    const stale = await declare(directory, 'stale', { ...declaration(), game: game() });
    assert.match(stale.gameError, /game requires contract 2/); assert.equal(stale.game, undefined); assert.equal(stale.formats[0].id, 'fixture-pack', 'formats survive a game problem');
    const cases = {
      'bad env key': [{ env: { build_type: 'x' } }, /env key build_type/],
      'reserved RENGINE_ key': [{ env: { RENGINE_SURFACE_PORT: '1' } }, /RENGINE_SURFACE_PORT is reserved/],
      'reserved DYLD_ key': [{ env: { DYLD_INSERT_LIBRARIES: '/x.dylib' } }, /DYLD_INSERT_LIBRARIES is reserved/],
      'reserved LD_ key': [{ env: { LD_PRELOAD: '/x.so' } }, /LD_PRELOAD is reserved/],
      'env value not a string': [{ env: { FLAVOUR: 1 } }, /env\.FLAVOUR/],
      'placeholder in args': [{ args: ['--file', '${file}'] }, /args\[1\]/],
      'nine executables': [{ executable: Array.from({ length: 9 }, (_, i) => `build/game-${i}`) }, /executable allows at most 8/],
      'no executables': [{ executable: [] }, /executable needs at least 1/],
      'shell executable': [{ executable: ['build/game | tee'] }, /executable\[0\]/],
      'unknown surface': [{ surface: 'wayland' }, /surface must be one of "sdl2-interpose", "external"/],
      'unknown key': [{ shell: true }, /unknown key shell/],
      'long title': [{ title: 'x'.repeat(33) }, /title is longer than 32/],
      'bad id': [{ id: 'Fixture Game' }, /id does not match/],
      'escaping requires': [{ requires: ['../secret.env'] }, /requires\[0\] must be root-relative/],
      'absolute requires': [{ requires: ['/etc/hosts'] }, /requires\[0\] must be root-relative/],
      'missing surface': [{ surface: undefined }, /requires surface/],
    };
    for (const [label, [extra, pattern]] of Object.entries(cases)) {
      const result = await declare(directory, label.replaceAll(/[^a-z0-9]/g, '-'), gameDeclaration(extra));
      assert.equal(result.error, undefined, `${label}: formats stay valid`); assert.match(result.gameError ?? '', pattern, label); assert.equal(result.game, undefined, label);
    }
    const three = await declare(directory, 'three', gameDeclaration({}, { ...declaration(), contract: 3 })); assert.match(three.error, /unknown contract 3/); assert.deepEqual(three.formats, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('preflight names the undeclared root, the malformed declaration, missing candidates and missing required files', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-game-preflight-')));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const preflight = async rootPath => { const root = await server.store.addRoot(rootPath); return { root, config: await request(server, `game-config?${new URLSearchParams({ rootId: root.id })}`) }; };
  const undeclared = path.join(directory, 'undeclared'); await mkdir(undeclared);
  const none = await preflight(undeclared);
  assert.deepEqual(none.config, { rootId: none.root.id, declared: false, args: [], cwd: undeclared, issues: ['This project declares no game in .rengine/project.json (contract 2).'], ready: false });
  const formatsOnly = path.join(directory, 'formats-only'); await mkdir(path.join(formatsOnly, '.rengine'), { recursive: true });
  await writeFile(path.join(formatsOnly, '.rengine/project.json'), JSON.stringify({ ...declaration(), contract: 2 }));
  assert.deepEqual((await preflight(formatsOnly)).config.issues, ['This project declares no game in .rengine/project.json (contract 2).']);
  const broken = path.join(directory, 'broken'); await mkdir(path.join(broken, '.rengine'), { recursive: true });
  await writeFile(path.join(broken, '.rengine/project.json'), JSON.stringify(gameDeclaration({ surface: 'wayland' })));
  const malformed = (await preflight(broken)).config;
  assert.equal(malformed.declared, false); assert.equal(malformed.ready, false); assert.equal(malformed.issues.length, 1); assert.match(malformed.issues[0], /surface must be one of/);
  const missing = await preflight(await gameProject(directory, 'missing', gameDeclaration({ executable: ['build/game-a', 'build/game-b'], requires: ['data/present.bin', 'data/absent.bin', 'nolf/absent.rez'] })));
  assert.equal(missing.config.declared, true); assert.equal(missing.config.ready, false); assert.equal(missing.config.executable, undefined);
  assert.deepEqual(missing.config.issues, ['Game executable not found; expected build/game-a or build/game-b in the selected project.', 'Required file is missing: data/absent.bin.', 'Required file is missing: nolf/absent.rez.']);
  const ready = await preflight(await gameProject(directory, 'ready'));
  assert.deepEqual(ready.config, { rootId: ready.root.id, declared: true, id: 'fixture-game', title: 'Fixture game', surface: 'external', executable: path.join(ready.root.path, 'tools/game.sh'),
    args: ['--flat', '--width', '640'], env: { FIXTURE_FLAVOUR: 'blue' }, requires: ['data/present.bin'], cwd: ready.root.path, issues: [], ready: true });
  const absolute = await preflight(await gameProject(directory, 'absolute', gameDeclaration({ executable: [path.join(directory, 'ready/tools/game.sh')] })));
  assert.equal(absolute.config.executable, path.join(directory, 'ready/tools/game.sh')); assert.equal(absolute.config.ready, true);
  const bare = await preflight(await gameProject(directory, 'bare', gameDeclaration({ executable: ['definitely-missing-game-9f', 'sh'], args: ['-c', 'echo BARE'] })));
  assert.ok(path.isAbsolute(bare.config.executable) && path.basename(bare.config.executable) === 'sh', bare.config.executable); assert.equal(bare.config.ready, true);
  const interpose = await preflight(await gameProject(directory, 'interpose', gameDeclaration({ surface: 'sdl2-interpose' })));
  assert.equal(interpose.config.surface, 'sdl2-interpose');
  if (process.platform === 'darwin') assert.match(interpose.config.adapter, /librengine_surface\.dylib$/);
  else assert.ok(interpose.config.issues.some(x => /qualification on this platform/.test(x)));
  assert.equal(ready.config.adapter, undefined, 'external games need no adapter');
});

test('an external game launches in its own window, reuses its session and exposes generic agent tools', { timeout: 30000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-game-launch-')));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  let client;
  t.after(async () => { await client?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await request(server, 'state')).capabilities.projectGame, 1);
  const rootPath = await gameProject(directory, 'game'), root = await server.store.addRoot(rootPath);
  const listed = await request(server, `formats?${new URLSearchParams({ rootId: root.id })}`);
  assert.equal(listed.game.title, 'Fixture game'); assert.equal(listed.game.surface, 'external'); assert.equal(listed.game.id, 'fixture-game');
  const undeclared = await server.store.addRoot(path.join(directory, 'state'));
  await assert.rejects(request(server, 'game', { rootId: undeclared.id }), /declares no game/);
  const session = await request(server, 'game', { rootId: root.id });
  assert.equal(session.type, 'game'); assert.equal(session.title, 'Fixture game · game'); assert.equal(session.surface, 'external'); assert.equal(session.game, 'fixture-game'); assert.equal(session.rootId, root.id);
  await waitOutput(server, session.id, 'FIXTURE_GAME_STARTED');
  assert.match(server.sessions.snapshot(session.id, true).output, new RegExp(`FIXTURE_GAME_STARTED args=--flat --width 640 flavour=blue cwd=${rootPath.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(server.games.surfaces.items.size, 0, 'no surface reservation for an external game'); assert.equal(server.games.items.size, 0);
  assert.equal((await request(server, 'game', { rootId: root.id })).id, session.id, 'the running session is reused');
  const state = await request(server, 'state'); const snapshot = state.sessions.find(x => x.id === session.id);
  assert.equal(snapshot.surface, 'external'); assert.equal(snapshot.game, 'fixture-game'); assert.equal(snapshot.title, 'Fixture game · game');
  await assert.rejects(request(server, 'terminal', { rootId: root.id, type: 'game' }), /game adapter/);
  const context = path.join(directory, 'context.json');
  await writeFile(context, JSON.stringify({ url: server.url, token: server.token, instance: server.instance, rootId: root.id }), { mode: 0o600 });
  client = new Client({ name: 'game-proof', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('orchestrator/agents/mcp.mjs'), '--context', context], stderr: 'pipe' }));
  const tools = (await client.listTools()).tools, names = tools.map(x => x.name);
  assert.ok(names.includes('game_preflight') && names.includes('launch_game'), names.join(','));
  assert.ok(!names.some(name => /nolf/i.test(name)), 'no game-specific tool names');
  for (const tool of tools) assert.doesNotMatch(`${tool.name} ${tool.description}`, /nolf/i, tool.name);
  assert.equal(tools.find(x => x.name === 'game_preflight').annotations.readOnlyHint, true);
  assert.equal(tools.find(x => x.name === 'launch_game').annotations.openWorldHint, true);
  const preflight = await client.callTool({ name: 'game_preflight', arguments: {} });
  assert.equal(preflight.isError, undefined); assert.equal(preflight.structuredContent.ready, true); assert.equal(preflight.structuredContent.title, 'Fixture game');
  const launched = await client.callTool({ name: 'launch_game', arguments: {} });
  assert.equal(launched.isError, undefined); assert.equal(launched.structuredContent.id, session.id, 'the tool reuses the running session');
  const stopped = await client.callTool({ name: 'stop_session', arguments: { id: session.id } });
  assert.equal(stopped.isError, undefined); assert.equal(await waitExit(server, session.id), 'exited');
  const again = await request(server, 'game', { rootId: root.id });
  assert.notEqual(again.id, session.id, 'a stopped game launches afresh'); await waitOutput(server, again.id, 'FIXTURE_GAME_STARTED');
  await server.sessions.stop(again.id); assert.equal(await waitExit(server, again.id), 'exited');
});

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
import { absent, game, gameDeclaration, gameProject, gamesDeclaration, second } from './game-fixtures.mjs';

const declare = async (directory, name, document) => {
  const root = path.join(directory, name); await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document)); return readDeclaration(root);
};
const waitOutput = async (server, id, text) => { for (let i = 0; i < 100; i++) { if (server.sessions.snapshot(id, true).output.includes(text)) return; await delay(50); } throw new Error(`session never printed ${text}`); };
const waitExit = async (server, id) => { for (let i = 0; i < 150 && server.sessions.snapshot(id).state !== 'exited'; i++) await delay(20); return server.sessions.snapshot(id).state; };

test('contract 3 games arrays validate, earlier contracts stay accepted and games errors are named and isolated', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-game-decl-')));
  try {
    const one = await declare(directory, 'one', declaration()); assert.equal(one.contract, 1); assert.equal(one.error, undefined); assert.equal(one.games, undefined); assert.equal(one.gamesError, undefined);
    const two = await declare(directory, 'two', { ...declaration(), contract: 2 }); assert.equal(two.contract, 2); assert.equal(two.error, undefined); assert.equal(two.games, undefined); assert.equal(two.gamesError, undefined);
    const plain = await declare(directory, 'plain', { ...declaration(), contract: 3 }); assert.equal(plain.contract, 3); assert.equal(plain.games, undefined); assert.equal(plain.gamesError, undefined);
    const full = await declare(directory, 'full', gameDeclaration());
    assert.equal(full.error, undefined); assert.equal(full.gamesError, undefined); assert.deepEqual(full.games, [game()]); assert.equal(full.formats[0].id, 'fixture-pack');
    const pair = await declare(directory, 'pair', gamesDeclaration([game(), second()]));
    assert.equal(pair.gamesError, undefined); assert.deepEqual(pair.games.map(x => x.id), ['fixture-game', 'fixture-second']);
    const minimal = await declare(directory, 'minimal', gameDeclaration({ args: undefined, env: undefined, requires: undefined }));
    assert.equal(minimal.gamesError, undefined); assert.deepEqual(minimal.games, [{ id: 'fixture-game', title: 'Fixture game', executable: ['build/missing-game', 'tools/game.sh'], surface: 'external' }]);

    /* The bump is the point: an older reader answers "unknown contract 3"; this one names the contract that games needs. */
    for (const contract of [1, 2]) {
      const stale = await declare(directory, `stale-${contract}`, { ...gameDeclaration(), contract });
      assert.match(stale.gamesError, /games requires contract 3/, `contract ${contract}`);
      assert.match(stale.gamesError, new RegExp(`declared contract ${contract}`));
      assert.equal(stale.games, undefined); assert.equal(stale.formats[0].id, 'fixture-pack', 'formats survive a games problem');
    }
    const cases = {
      'bad env key': [{ env: { build_type: 'x' } }, /env key build_type/],
      'reserved RENGINE_ key': [{ env: { RENGINE_SURFACE_PORT: '1' } }, /RENGINE_SURFACE_PORT is reserved/],
      'reserved DYLD_ key': [{ env: { DYLD_INSERT_LIBRARIES: '/x.dylib' } }, /DYLD_INSERT_LIBRARIES is reserved/],
      'reserved LD_ key': [{ env: { LD_PRELOAD: '/x.so' } }, /LD_PRELOAD is reserved/],
      'env value not a string': [{ env: { FLAVOUR: 1 } }, /env\.FLAVOUR/],
      'placeholder in args': [{ args: ['--file', '${file}'] }, /games\[0\]\.args\[1\]/],
      'nine executables': [{ executable: Array.from({ length: 9 }, (_, i) => `build/game-${i}`) }, /executable allows at most 8/],
      'no executables': [{ executable: [] }, /executable needs at least 1/],
      'shell executable': [{ executable: ['build/game | tee'] }, /executable\[0\]/],
      'unknown surface': [{ surface: 'sdl2-interpose' }, /surface must be one of "embedded", "external"/],
      'unknown key': [{ shell: true }, /unknown key shell/],
      'long title': [{ title: 'x'.repeat(33) }, /title is longer than 32/],
      'bad id': [{ id: 'Fixture Game' }, /id does not match/],
      'escaping requires': [{ requires: ['../secret.env'] }, /requires\[0\] must be root-relative/],
      'absolute requires': [{ requires: ['/etc/hosts'] }, /requires\[0\] must be root-relative/],
      'escaping cwd': [{ cwd: '../elsewhere' }, /games\[0\]\.cwd must be root-relative/],
      'absolute cwd': [{ cwd: '/tmp' }, /games\[0\]\.cwd must be root-relative/],
      'missing surface': [{ surface: undefined }, /requires surface/],
    };
    for (const [label, [extra, pattern]] of Object.entries(cases)) {
      const result = await declare(directory, label.replaceAll(/[^a-z0-9]/g, '-'), gameDeclaration(extra));
      assert.equal(result.error, undefined, `${label}: formats stay valid`); assert.match(result.gamesError ?? '', pattern, label); assert.equal(result.games, undefined, label);
    }
    const duplicate = await declare(directory, 'duplicate', gamesDeclaration([game(), second({ id: 'fixture-game' })]));
    assert.match(duplicate.gamesError, /games\[1\]\.id repeats "fixture-game"/); assert.equal(duplicate.games, undefined);
    const seventeen = await declare(directory, 'seventeen', gamesDeclaration(Array.from({ length: 17 }, (_, i) => game({ id: `fixture-${i}` }))));
    assert.match(seventeen.gamesError, /games allows at most 16 items/); assert.equal(seventeen.games, undefined);
    const empty = await declare(directory, 'empty', gamesDeclaration([]));
    assert.match(empty.gamesError, /games needs at least 1 item/); assert.equal(empty.games, undefined);
    const rootCwd = await declare(directory, 'root-cwd', gameDeclaration({ cwd: '' }));
    assert.equal(rootCwd.gamesError, undefined, 'an empty cwd means the project root'); assert.equal(rootCwd.games[0].cwd, '');
    const four = await declare(directory, 'four', { ...gameDeclaration(), contract: 4 }); assert.match(four.error, /unknown contract 4/); assert.deepEqual(four.formats, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('preflight names the undeclared root, the malformed declaration, missing candidates, files and working directory', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-game-preflight-')));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const preflight = async (rootPath, gameId) => {
    const root = await server.store.addRoot(rootPath);
    return { root, config: await request(server, `game-config?${new URLSearchParams({ rootId: root.id, ...(gameId ? { gameId } : {}) })}`) };
  };
  const undeclared = path.join(directory, 'undeclared'); await mkdir(undeclared);
  const none = await preflight(undeclared);
  assert.deepEqual(none.config, { rootId: none.root.id, declared: false, args: [], cwd: undeclared, issues: ['This project declares no games in .rengine/project.json (contract 3).'], ready: false });
  const formatsOnly = path.join(directory, 'formats-only'); await mkdir(path.join(formatsOnly, '.rengine'), { recursive: true });
  await writeFile(path.join(formatsOnly, '.rengine/project.json'), JSON.stringify({ ...declaration(), contract: 3 }));
  assert.deepEqual((await preflight(formatsOnly)).config.issues, ['This project declares no games in .rengine/project.json (contract 3).']);
  const broken = path.join(directory, 'broken'); await mkdir(path.join(broken, '.rengine'), { recursive: true });
  await writeFile(path.join(broken, '.rengine/project.json'), JSON.stringify(gameDeclaration({ surface: 'wayland' })));
  const malformed = (await preflight(broken)).config;
  assert.equal(malformed.declared, false); assert.equal(malformed.ready, false); assert.equal(malformed.issues.length, 1); assert.match(malformed.issues[0], /surface must be one of/);
  const missing = await preflight(await gameProject(directory, 'missing', gameDeclaration({ executable: ['build/game-a', 'build/game-b'], requires: ['data/present.bin', 'data/absent.bin', 'data/other.rez'], cwd: 'absent-dir' })));
  assert.equal(missing.config.declared, true); assert.equal(missing.config.ready, false); assert.equal(missing.config.executable, undefined);
  assert.deepEqual(missing.config.issues, ['Game executable not found; expected build/game-a or build/game-b in the selected project.',
    'Required file is missing: data/absent.bin.', 'Required file is missing: data/other.rez.', 'Working directory is missing: absent-dir.']);
  const ready = await preflight(await gameProject(directory, 'ready'));
  assert.deepEqual(ready.config, { rootId: ready.root.id, declared: true, id: 'fixture-game', title: 'Fixture game', surface: 'external', executable: path.join(ready.root.path, 'tools/game.sh'),
    args: ['--flat', '--width', '640'], env: { FIXTURE_FLAVOUR: 'blue' }, requires: ['data/present.bin'], cwd: ready.root.path, issues: [], ready: true });
  const work = await preflight(await gameProject(directory, 'work', gameDeclaration({ cwd: 'work' })));
  assert.equal(work.config.cwd, path.join(work.root.path, 'work')); assert.equal(work.config.ready, true);
  const absolute = await preflight(await gameProject(directory, 'absolute', gameDeclaration({ executable: [path.join(directory, 'ready/tools/game.sh')] })));
  assert.equal(absolute.config.executable, path.join(directory, 'ready/tools/game.sh')); assert.equal(absolute.config.ready, true);
  const bare = await preflight(await gameProject(directory, 'bare', gameDeclaration({ executable: ['definitely-missing-game-9f', 'sh'], args: ['-c', 'echo BARE'] })));
  assert.ok(path.isAbsolute(bare.config.executable) && path.basename(bare.config.executable) === 'sh', bare.config.executable); assert.equal(bare.config.ready, true);
  const embedded = await preflight(await gameProject(directory, 'embedded', gameDeclaration({ surface: 'embedded' })));
  assert.equal(embedded.config.surface, 'embedded');
  if (process.platform === 'darwin') assert.match(embedded.config.adapter, /librengine_surface\.dylib$/);
  else assert.ok(embedded.config.issues.some(x => /qualification on this platform/.test(x)));
  assert.equal(ready.config.adapter, undefined, 'external games need no adapter');

  const first = await preflight(await gameProject(directory, 'many', gamesDeclaration([game(), absent(), second()])));
  assert.equal(first.config.id, 'fixture-game', 'an omitted gameId selects the first declared game');
  const chosen = await request(server, `game-config?${new URLSearchParams({ rootId: first.root.id, gameId: 'fixture-second' })}`);
  assert.equal(chosen.id, 'fixture-second'); assert.equal(chosen.title, 'Fixture second'); assert.equal(chosen.ready, true);
  const failing = await request(server, `game-config?${new URLSearchParams({ rootId: first.root.id, gameId: 'fixture-absent' })}`);
  assert.equal(failing.ready, false); assert.deepEqual(failing.issues, ['Game executable not found; expected build/absent-game in the selected project.']);
  await assert.rejects(request(server, `game-config?${new URLSearchParams({ rootId: first.root.id, gameId: 'nope' })}`),
    /Unknown gameId "nope"[\s\S]*fixture-game, fixture-absent, fixture-second/);
});

test('declared games launch in their own window, run side by side and expose generic agent tools', { timeout: 40000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-game-launch-')));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  let client;
  t.after(async () => { await client?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await request(server, 'state')).capabilities.projectGame, 1);
  const rootPath = await gameProject(directory, 'game', gamesDeclaration([game({ cwd: 'work' }), second(), absent()])), root = await server.store.addRoot(rootPath);
  const listed = await request(server, `formats?${new URLSearchParams({ rootId: root.id })}`);
  assert.deepEqual(listed.games.map(x => [x.id, x.title, x.surface]),
    [['fixture-game', 'Fixture game', 'external'], ['fixture-second', 'Fixture second', 'external'], ['fixture-absent', 'Fixture absent', 'external']]);
  const undeclared = await server.store.addRoot(path.join(directory, 'state'));
  await assert.rejects(request(server, 'game', { rootId: undeclared.id }), /declares no games/);
  await assert.rejects(request(server, 'game', { rootId: root.id, gameId: 'fixture-absent' }), /Game executable not found/);
  const session = await request(server, 'game', { rootId: root.id });
  assert.equal(session.type, 'game'); assert.equal(session.title, 'Fixture game · game'); assert.equal(session.surface, 'external'); assert.equal(session.game, 'fixture-game'); assert.equal(session.rootId, root.id);
  await waitOutput(server, session.id, 'FIXTURE_GAME_STARTED');
  const quoted = value => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(server.sessions.snapshot(session.id, true).output, new RegExp(`FIXTURE_GAME_STARTED args=--flat --width 640 flavour=blue cwd=${quoted(path.join(rootPath, 'work'))}`));
  assert.equal(server.games.surfaces.items.size, 0, 'no surface reservation for an external game'); assert.equal(server.games.items.size, 0);
  assert.equal((await request(server, 'game', { rootId: root.id })).id, session.id, 'the running session is reused');
  assert.equal((await request(server, 'game', { rootId: root.id, gameId: 'fixture-game' })).id, session.id, 'reuse is keyed by game id');

  const other = await request(server, 'game', { rootId: root.id, gameId: 'fixture-second' });
  assert.notEqual(other.id, session.id, 'a second declared game of the same root runs beside the first');
  assert.equal(other.game, 'fixture-second'); assert.equal(other.title, 'Fixture second · game');
  await waitOutput(server, other.id, 'FIXTURE_SECOND_STARTED');
  assert.match(server.sessions.snapshot(other.id, true).output, new RegExp(`FIXTURE_SECOND_STARTED args=--second flavour=unset cwd=${quoted(rootPath)}`));
  assert.equal((await request(server, 'state')).sessions.filter(x => x.type === 'game' && x.state === 'running').length, 2);

  const snapshot = (await request(server, 'state')).sessions.find(x => x.id === session.id);
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
  for (const name of ['game_preflight', 'launch_game']) assert.ok(tools.find(x => x.name === name).inputSchema.properties?.gameId, `${name} takes an optional gameId`);
  const preflight = await client.callTool({ name: 'game_preflight', arguments: {} });
  assert.equal(preflight.isError, undefined); assert.equal(preflight.structuredContent.ready, true); assert.equal(preflight.structuredContent.title, 'Fixture game');
  const selected = await client.callTool({ name: 'game_preflight', arguments: { gameId: 'fixture-absent' } });
  assert.equal(selected.structuredContent.ready, false); assert.match(selected.structuredContent.issues[0], /Game executable not found/);
  const launched = await client.callTool({ name: 'launch_game', arguments: { gameId: 'fixture-second' } });
  assert.equal(launched.isError, undefined); assert.equal(launched.structuredContent.id, other.id, 'the tool reuses the running session of that game id');
  for (const id of [session.id, other.id]) {
    const stopped = await client.callTool({ name: 'stop_session', arguments: { id } });
    assert.equal(stopped.isError, undefined); assert.equal(await waitExit(server, id), 'exited');
  }
  const again = await request(server, 'game', { rootId: root.id });
  assert.notEqual(again.id, session.id, 'a stopped game launches afresh'); await waitOutput(server, again.id, 'FIXTURE_GAME_STARTED');
  await server.sessions.stop(again.id); assert.equal(await waitExit(server, again.id), 'exited');
});

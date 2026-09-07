import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDeclaration, CONTRACTS } from '../server/formats.mjs';
import { validateSchema } from '../server/schema.mjs';
import { declaration } from './format-fixtures.mjs';
import { dashboard } from './dashboard-fixtures.mjs';
import { game, second } from './game-fixtures.mjs';
import { thisMachine, answering } from './device-fixtures.mjs';

// The contract-9 pack manifest (spec 107, charter D39, D24 clarified). A pack is one pinned,
// versioned artifact whose facets say how it is consumed: a library facet at build time, a plugin
// facet at run time. Nothing here acquires or loads anything — see the spec's out-of-scope table.
const schema = JSON.parse(readFileSync('contracts/project-v1.schema.json', 'utf8'));
const SHA1 = '9f1c0b2a7d5e4c3b8a06f2d1e9c7b5a4302f1e8d';
const SHA256 = '4c2f8b1d0e6a9375c4b8d2e1f0a763958c1d4e2b0f7a6394d8c2b1e0f5a39476';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#CC4F4C"/></svg>';

const declare = async (directory, name, document) => {
  const root = path.join(directory, name);
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document));
  return readDeclaration(root);
};
const library = (extra = {}) => ({ path: 'third_party/iklib', target: 'iklib::ik', ...extra });
const plugin = (extra = {}) => ({ module: 'build/plugins/red-inspector.dylib', abi: 're-plugin-1', ...extra });
const pin = (extra = {}) => ({ version: '0.4.0', revision: SHA1, ...extra });
const pack = (extra = {}) => ({ name: 'iklib', pin: pin(), ...extra });
const packed = (packs, extra = {}) => ({ ...declaration(), contract: 9, packs, ...extra });

test('contract 9 carries a pack whose facets are a library and a plugin (spec 107)', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-packs-')));
  t.after(() => rm(directory, { recursive: true, force: true }));

  // The ceiling moved with the block; a reader that predates contract 9 must say "unknown contract"
  // rather than "unknown key", which is only true while these two agree.
  assert.equal(CONTRACTS.at(-1), 9, 'the ceiling moved with the packs block');
  assert.ok(schema.properties.contract.enum.includes(9), 'the schema knows contract 9 too');

  // The renderer's shape (D30): one artifact, one pin, consumed at build time by a game and loaded
  // at run time by the editor.
  const renderer = { name: 'rengine-render', pin: { version: '0.2.0', revision: SHA1 },
    library: { path: 'render', target: 'rengine::render' },
    plugin: { module: 'build/plugins/rengine-render.dylib', abi: 're-plugin-1' } };
  const document = packed([renderer]);
  assert.deepEqual(validateSchema(schema, document), [], 'a contract-9 document validates structurally');

  const read = await declare(directory, 'both-facets', document);
  assert.equal(read.contract, 9);
  assert.equal(read.error, undefined, `a contract-9 pack should be accepted: ${read.error}`);
  assert.equal(read.packsError, undefined, `no pack problem expected: ${read.packsError}`);
  assert.deepEqual(read.packs, [renderer], 'the pack reaches the reader whole rather than being dropped in silence');
  assert.deepEqual(read.packs[0].library, { path: 'render', target: 'rengine::render' });
  assert.deepEqual(read.packs[0].plugin, { module: 'build/plugins/rengine-render.dylib', abi: 're-plugin-1' });
  assert.equal(read.formats[0].id, 'fixture-pack', 'the formats are untouched by the new block');

  // iklib's own shape (D23, D24, spec 001): a library facet and the powered-by claim's subject.
  const iklib = pack({ poweredBy: true, library: library() });
  const adopted = await declare(directory, 'iklib', packed([iklib]));
  assert.equal(adopted.packsError, undefined, `iklib should be accepted: ${adopted.packsError}`);
  assert.deepEqual(adopted.packs, [iklib]);
  assert.equal(adopted.packs[0].pin.revision, SHA1, 'the revision is the identity, carried verbatim');
  assert.equal(adopted.packs[0].pin.version, '0.4.0', 'the version is the label, carried verbatim');

  // An editor plugin (D38): the other facet alone, with a SHA-256 pin, and no powered-by claim.
  const inspector = { name: 'red-inspector', pin: { version: '0.1.2', revision: SHA256 }, plugin: plugin() };
  const loaded = await declare(directory, 'plugin-only', packed([inspector]));
  assert.equal(loaded.packsError, undefined, `an editor plugin should be accepted: ${loaded.packsError}`);
  assert.deepEqual(loaded.packs, [inspector]);

  // The abi is opaque: its shape is checked and its meaning belongs to the plugin-ABI lane, so a
  // string this reader knows nothing about passes through untouched rather than being ranked.
  const strange = await declare(directory, 'strange-abi', packed([{ ...inspector, plugin: plugin({ abi: '2026.09.07+draft-7' }) }]));
  assert.equal(strange.packsError, undefined, `an unfamiliar abi is not this reader's business: ${strange.packsError}`);
  assert.equal(strange.packs[0].plugin.abi, '2026.09.07+draft-7');

  // Two packs, two names, both facets in use across them: the list is one list (D39).
  const many = await declare(directory, 'many', packed([iklib, inspector, renderer]));
  assert.equal(many.packsError, undefined, `three packs should be accepted: ${many.packsError}`);
  assert.deepEqual(many.packs.map(entry => entry.name), ['iklib', 'red-inspector', 'rengine-render']);
});

test('packs on contract 8 is refused for the contract it needs, not as an unknown key', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-packs-contract-')));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const eight = await declare(directory, 'eight', packed([pack({ library: library() })], { contract: 8 }));
  assert.ok(!/unknown key packs/.test(eight.error ?? ''),
    'packs is a known key at every contract; a reader that has the block refuses the contract, never the key');
  assert.match(eight.packsError, /packs requires contract 9 \(declared contract 8\)/,
    'a reader that has the block still refuses it below its floor, by the contract it needs');
  assert.ok(!/unknown key/.test(eight.packsError ?? ''), 'never as an unknown key: the key is known, the contract is not');
  assert.equal(eight.packs, undefined, 'nothing from a below-floor block reaches a consumer');
  assert.equal(eight.error, undefined, 'the declaration as a whole survives its packs block');
  assert.equal(eight.formats[0].id, 'fixture-pack', 'contract 8 still lists its formats');

  const one = await declare(directory, 'one', { ...declaration(), packs: [pack({ library: library() })] });
  assert.match(one.packsError, /packs requires contract 9 \(declared contract 1\)/);
  assert.equal(one.formats[0].id, 'fixture-pack');

  const beyond = CONTRACTS.at(-1) + 1;
  const future = await declare(directory, 'future', packed([pack({ library: library() })], { contract: beyond }));
  assert.match(future.error, new RegExp(`unknown contract ${beyond}`), 'a contract past the ceiling is refused whole');
  assert.match(future.error, /supports contracts 1, 2, 3, 4, 5, 6, 7, 8 and 9/, 'and the refusal names what it does support');
});

test('each pack refusal names the pack and the key (spec 107)', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-packs-refusals-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const refuse = (name, packs) => declare(directory, name, packed(packs));

  // A facet key under the wrong facet. The schema refuses the unknown key; the rule says where the
  // key belongs, which is the half that tells a human what to do about it.
  const strayLibraryKey = await refuse('stray-library-key', [pack({ plugin: plugin({ target: 'iklib::ik' }) })]);
  assert.match(strayLibraryKey.packsError, /\$\.packs\[0\] \(iklib\)\.plugin\.target belongs to the library facet/);
  assert.equal(strayLibraryKey.packs, undefined, 'a bad pack fails its section whole');
  assert.equal(strayLibraryKey.formats[0].id, 'fixture-pack', 'and takes nothing else with it');

  const strayPluginKey = await refuse('stray-plugin-key', [pack({ library: library({ module: 'build/x.dylib' }) })]);
  assert.match(strayPluginKey.packsError, /\$\.packs\[0\] \(iklib\)\.library\.module belongs to the plugin facet/);

  const strayAbi = await refuse('stray-abi', [pack({ library: library({ abi: 're-plugin-1' }) })]);
  assert.match(strayAbi.packsError, /\$\.packs\[0\] \(iklib\)\.library\.abi belongs to the plugin facet/);

  // A pack declaring no facet at all: a name and a version with nothing on the other end of them.
  const facetless = await refuse('facetless', [pack()]);
  assert.match(facetless.packsError, /\$\.packs\[0\] \(iklib\) declares no facet; a pack declares library, plugin or both/);

  // A repeated pack name, placed by the occurrence's index rather than by the name it repeats, so
  // the report points at the entry to go and look at.
  const twice = await refuse('twice', [pack({ library: library() }), pack({ plugin: plugin() })]);
  assert.match(twice.packsError, /\$\.packs\[1\]\.name repeats "iklib"/);
  assert.ok(!/\$\.packs\[0\]\.name repeats/.test(twice.packsError), 'the first occurrence is not the problem');

  // D24 clarified: the claim is earned on the library facet. An editor plugin does not earn it.
  const claiming = await refuse('claiming', [{ name: 'red-inspector', pin: { version: '0.1.2', revision: SHA256 }, poweredBy: true, plugin: plugin() }]);
  assert.match(claiming.packsError, /\$\.packs\[0\] \(red-inspector\)\.poweredBy is earned by a library facet; an editor plugin does not earn it/);
  const earned = await refuse('earned', [pack({ poweredBy: true, library: library() })]);
  assert.equal(earned.packsError, undefined, 'the same key on a library facet is exactly what D24 defines');

  // A pin whose revision is a name is not a pin: tags move, and two machines saying 0.4.0 can hold
  // different bytes. The version is the label; the revision is the identity.
  for (const revision of ['main', 'v0.4.0', 'HEAD', '9f1c0b2', SHA1.toUpperCase(), `${SHA1}0`]) {
    const named = await refuse(`revision-${revision.replace(/\W/g, '')}`, [pack({ pin: pin({ revision }), library: library() })]);
    assert.match(named.packsError, /\$\.packs\[0\] \(iklib\)\.pin\.revision must be a 40- or 64-character hex digest/,
      `${revision} must be refused as a revision`);
    assert.ok(named.packsError.includes(JSON.stringify(revision)), 'and the refusal quotes what was written');
  }
  const sha256 = await refuse('sha256', [pack({ pin: pin({ revision: SHA256 }), library: library() })]);
  assert.equal(sha256.packsError, undefined, 'a 64-character digest is a pin too');

  // Declared paths are root-relative, like every other path in this contract.
  for (const escape of ['../elsewhere/iklib', '/opt/iklib', 'third_party/../../iklib']) {
    const out = await refuse(`escape-${escape.replace(/\W/g, '')}`, [pack({ library: library({ path: escape }) })]);
    assert.match(out.packsError, /\$\.packs\[0\] \(iklib\)\.library\.path must be root-relative/, `${escape} must be refused`);
  }
  const escapingModule = await refuse('escaping-module', [pack({ plugin: plugin({ module: '../evil.dylib' }) })]);
  assert.match(escapingModule.packsError, /\$\.packs\[0\] \(iklib\)\.plugin\.module must be root-relative/);

  // A record with no name is placed by its index and never printed as undefined (spec 078's rule).
  const anonymous = await refuse('anonymous', [{ pin: pin(), library: library({ path: '/opt/iklib' }) }]);
  assert.match(anonymous.packsError, /\$\.packs\[0\]\.library\.path must be root-relative/);
  assert.ok(!/undefined/.test(anonymous.packsError), 'a missing name is never printed as undefined');

  // Structural floors the schema owns, reported through the same key.
  const empty = await refuse('empty', []);
  assert.match(empty.packsError, /\$\.packs needs at least 1 items/, 'an empty list is a block that says nothing');
  const nameless = await refuse('nameless', [{ pin: pin(), library: library() }]);
  assert.match(nameless.packsError, /\$\.packs\[0\] requires name/);
  const unpinned = await refuse('unpinned', [{ name: 'iklib', library: library() }]);
  assert.match(unpinned.packsError, /\$\.packs\[0\] requires pin/);
  const halfPin = await refuse('half-pin', [{ name: 'iklib', pin: { version: '0.4.0' }, library: library() }]);
  assert.match(halfPin.packsError, /\$\.packs\[0\]\.pin requires revision/);
  const targetless = await refuse('targetless', [pack({ library: { path: 'third_party/iklib' } })]);
  assert.match(targetless.packsError, /\$\.packs\[0\]\.library requires target/);
  const abiless = await refuse('abiless', [pack({ plugin: { module: 'build/x.dylib' } })]);
  assert.match(abiless.packsError, /\$\.packs\[0\]\.plugin requires abi/);
});

test('a declaration that does not name packs reads exactly as it did (the ten blocks of contracts 1-8)', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-packs-unchanged-')));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const everything = {
    ...declaration(), contract: 8, title: 'Fixture',
    icon: { glyph: 'Fx', token: 'accent' },
    wordmark: 'brand/wordmark.svg',
    tracker: { provider: 'local', inventory: 'features.json', write: ['tools/write-task.mjs', '${json}'] },
    agents: [{ cli: 'claude', models: ['claude-opus-5', 'claude-sonnet-5'], default: 'claude-opus-5' }],
    languageServers: [{ id: 'clangd', command: ['clangd'], match: ['*.c'] }],
    devices: [thisMachine(), answering()],
    games: [game(), second()],
    dashboard: dashboard(),
  };
  const { dashboard: _b, games: _g, devices: _d, tracker: _t, ...rootBlocks } = everything; /* the four blocks readDeclaration validates through SECTIONS instead */
  assert.deepEqual(validateSchema(schema, rootBlocks), [], 'the ten-block document still validates structurally');

  const root = path.join(directory, 'ten');
  await mkdir(path.join(root, 'brand'), { recursive: true });
  await writeFile(path.join(root, 'brand/wordmark.svg'), SVG);
  const read = await declare(directory, 'ten', everything);

  assert.equal(read.error, undefined, `the ten-block declaration should be accepted: ${read.error}`);
  for (const key of ['artworkError', 'languageServersError', 'trackerError', 'devicesError', 'gamesError', 'dashboardError']) {
    assert.equal(read[key], undefined, `${key} should be unset: ${read[key]}`);
  }
  // The exact key set, so a new block cannot leak into a declaration that never asked for it.
  assert.deepEqual(Object.keys(read).sort(), ['agents', 'contract', 'dashboard', 'declared', 'devices', 'formats',
    'games', 'icon', 'languageServers', 'project', 'source', 'title', 'tracker', 'wordmark'].sort(),
    'a declaration without packs carries neither packs nor packsError');

  assert.equal(read.contract, 8);
  assert.equal(read.title, 'Fixture');
  assert.deepEqual(read.icon, { glyph: 'Fx', token: 'accent' });
  assert.equal(read.wordmark.lightFile, path.join(root, 'brand/wordmark.svg'));
  assert.deepEqual(read.tracker, everything.tracker);
  assert.deepEqual(read.agents, everything.agents);
  assert.deepEqual(read.languageServers, everything.languageServers);
  assert.deepEqual(read.devices.map(device => device.id), ['local', 'answering-box']);
  assert.deepEqual(read.games.map(entry => entry.id), ['fixture-game', 'fixture-second']);
  assert.deepEqual(read.dashboard.groups.map(group => group.id), ['build', 'device']);
  assert.equal(read.formats[0].id, 'fixture-pack');
});

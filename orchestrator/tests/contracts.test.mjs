import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDeclaration, matchFormat } from '../server/formats.mjs';
import { validateSchema } from '../server/schema.mjs';
import { declaration } from './format-fixtures.mjs';
import { game, second } from './game-fixtures.mjs';
import { dashboard } from './dashboard-fixtures.mjs';

const schema = JSON.parse(readFileSync('contracts/project-v1.schema.json', 'utf8'));
const fixture = name => JSON.parse(readFileSync(`orchestrator/tests/fixtures/${name}`, 'utf8'));
const declare = async (directory, name, document) => {
  const root = path.join(directory, name); await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document)); return readDeclaration(root);
};
const all = (extra = {}) => ({ ...declaration(), contract: 3, games: [game(), second()], dashboard: dashboard(), ...extra });

test('contract 3 carries formats, games and dashboard together and reports each block on its own', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-contract3-')));
  try {
    assert.deepEqual(validateSchema(schema, all()), [], 'a formats + games + dashboard document validates structurally');
    const every = await declare(directory, 'all', all());
    assert.equal(every.contract, 3); assert.equal(every.error, undefined);
    assert.equal(every.gamesError, undefined); assert.equal(every.dashboardError, undefined);
    assert.equal(every.formats[0].id, 'fixture-pack');
    assert.deepEqual(every.games, [game(), second()]);
    assert.deepEqual(every.dashboard.groups.map(group => group.id), ['build', 'device']);

    const badGames = await declare(directory, 'bad-games', all({ games: [game({ surface: 'wayland' })] }));
    assert.match(badGames.gamesError, /surface/); assert.equal(badGames.games, undefined);
    assert.equal(badGames.dashboardError, undefined, 'a bad games array leaves the dashboard intact');
    assert.equal(badGames.dashboard.title, 'Fixture'); assert.equal(badGames.formats[0].id, 'fixture-pack');

    const badDashboard = await declare(directory, 'bad-dashboard', all({ dashboard: { title: 'Fixture', groups: [] } }));
    assert.ok(badDashboard.dashboardError, 'an empty dashboard is reported'); assert.equal(badDashboard.dashboard, undefined);
    assert.equal(badDashboard.gamesError, undefined, 'a bad dashboard leaves the games intact');
    assert.deepEqual(badDashboard.games, [game(), second()]); assert.equal(badDashboard.formats[0].id, 'fixture-pack');

    const two = await declare(directory, 'two', all({ contract: 2 }));
    assert.match(two.gamesError, /games requires contract 3/, 'games under contract 2 is rejected by the contract it needs');
    assert.equal(two.games, undefined);
    assert.equal(two.dashboardError, undefined, 'the contract-2 dashboard is unaffected'); assert.equal(two.dashboard.title, 'Fixture');
    assert.equal(two.formats[0].id, 'fixture-pack', 'contract 2 still lists its formats');

    const one = await declare(directory, 'one', { ...declaration(), games: [game()], dashboard: dashboard() });
    assert.match(one.gamesError, /games requires contract 3/); assert.match(one.dashboardError, /dashboard requires contract 2/);
    assert.equal(one.formats[0].id, 'fixture-pack', 'contract 1 still lists its formats');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the real consumer declarations validate through the reconciled contract', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-consumers-')));
  try {
    const vtmb = fixture('vtmb-project.json');
    assert.equal(vtmb.contract, 3, 'the vtmb-vr declaration is the contract-3 games array');
    assert.deepEqual(validateSchema(schema, vtmb), [], 'the vtmb-vr declaration validates with zero errors');
    const read = await declare(directory, 'vtmb', vtmb);
    assert.equal(read.contract, 3); assert.equal(read.error, undefined);
    assert.equal(read.gamesError, undefined); assert.equal(read.dashboardError, undefined);
    assert.equal(read.formats[0].id, 'troika-vpk');
    assert.deepEqual(read.games.map(x => [x.id, x.title, x.surface]), [['vtmb-flat', 'VtMB', 'external'], ['vtmb-vr', 'VtMB (VR)', 'external']]);
    assert.equal(read.dashboard.title, 'reSource');
    assert.equal(matchFormat(read.formats, 'gamedata/Vampire/pack000.vpk')?.id, 'troika-vpk');
    assert.equal(matchFormat(read.formats, 'PACK000.VPK')?.id, 'troika-vpk', 'the glob is case-insensitive');
    assert.equal(matchFormat(read.formats, 'pack000.txt'), null);

    const nolf = fixture('nolf-project.json');
    assert.deepEqual(validateSchema(schema, nolf), [], 'the contract-1 nolf-improved declaration is unchanged and valid');
    const first = await declare(directory, 'nolf', nolf);
    assert.equal(first.contract, 1); assert.equal(first.error, undefined);
    assert.equal(first.games, undefined); assert.equal(first.dashboard, undefined);
    assert.equal(first.gamesError, undefined); assert.equal(first.dashboardError, undefined);
    assert.equal(matchFormat(first.formats, 'nolf/NOLF.REZ')?.id, 'lithtech-rez');

    const merged = fixture('nolf-merged-project.json');
    assert.equal(merged.contract, 2, 'the live nolf-improved declaration is contract 2: formats and dashboard, no games');
    assert.equal(merged.games, undefined);
    assert.deepEqual(validateSchema(schema, merged), [], 'the live nolf-improved contract-2 document still validates unchanged');
    const two = await declare(directory, 'nolf-merged', merged);
    assert.equal(two.contract, 2); assert.equal(two.error, undefined); assert.equal(two.dashboardError, undefined);
    assert.equal(two.dashboard.title, 'reLith'); assert.equal(two.games, undefined); assert.equal(two.gamesError, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

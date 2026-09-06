import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDeclaration, matchFormat } from '../server/formats.mjs';
import { validateSchema } from '../server/schema.mjs';
import { declaration } from './format-fixtures.mjs';
import { game } from './game-fixtures.mjs';
import { dashboard } from './dashboard-fixtures.mjs';

const schema = JSON.parse(readFileSync('contracts/project-v1.schema.json', 'utf8'));
const fixture = name => JSON.parse(readFileSync(`orchestrator/tests/fixtures/${name}`, 'utf8'));
const declare = async (directory, name, document) => {
  const root = path.join(directory, name); await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document)); return readDeclaration(root);
};
const both = (extra = {}) => ({ ...declaration(), contract: 2, game: game(), dashboard: dashboard(), ...extra });

test('contract 2 carries formats, game and dashboard together and reports each block on its own', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-contract2-')));
  try {
    assert.deepEqual(validateSchema(schema, both()), [], 'a formats + game + dashboard document validates structurally');
    const all = await declare(directory, 'all', both());
    assert.equal(all.contract, 2); assert.equal(all.error, undefined);
    assert.equal(all.gameError, undefined); assert.equal(all.dashboardError, undefined);
    assert.equal(all.formats[0].id, 'fixture-pack');
    assert.deepEqual(all.game, game());
    assert.deepEqual(all.dashboard.groups.map(group => group.id), ['build', 'device']);

    const badGame = await declare(directory, 'bad-game', both({ game: game({ surface: 'wayland' }) }));
    assert.match(badGame.gameError, /surface/); assert.equal(badGame.game, undefined);
    assert.equal(badGame.dashboardError, undefined, 'a bad game leaves the dashboard intact');
    assert.equal(badGame.dashboard.title, 'Fixture'); assert.equal(badGame.formats[0].id, 'fixture-pack');

    const badDashboard = await declare(directory, 'bad-dashboard', both({ dashboard: { title: 'Fixture', groups: [] } }));
    assert.ok(badDashboard.dashboardError, 'an empty dashboard is reported'); assert.equal(badDashboard.dashboard, undefined);
    assert.equal(badDashboard.gameError, undefined, 'a bad dashboard leaves the game intact');
    assert.deepEqual(badDashboard.game, game()); assert.equal(badDashboard.formats[0].id, 'fixture-pack');

    const one = await declare(directory, 'one', { ...declaration(), game: game(), dashboard: dashboard() });
    assert.match(one.gameError, /game requires contract 2/); assert.match(one.dashboardError, /dashboard requires contract 2/);
    assert.equal(one.formats[0].id, 'fixture-pack', 'contract 1 still lists its formats');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the real consumer declarations validate through the reconciled contract', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-consumers-')));
  try {
    const vtmb = fixture('vtmb-project.json');
    assert.deepEqual(validateSchema(schema, vtmb), [], 'the vtmb-vr declaration validates with zero errors');
    const read = await declare(directory, 'vtmb', vtmb);
    assert.equal(read.contract, 2); assert.equal(read.error, undefined);
    assert.equal(read.gameError, undefined); assert.equal(read.dashboardError, undefined);
    assert.equal(read.formats[0].id, 'troika-vpk');
    assert.equal(read.game.id, 'vtmb-flat'); assert.equal(read.game.surface, 'external');
    assert.equal(read.dashboard.title, 'reSource');
    assert.equal(matchFormat(read.formats, 'gamedata/Vampire/pack000.vpk')?.id, 'troika-vpk');
    assert.equal(matchFormat(read.formats, 'PACK000.VPK')?.id, 'troika-vpk', 'the glob is case-insensitive');
    assert.equal(matchFormat(read.formats, 'pack000.txt'), null);

    const nolf = fixture('nolf-project.json');
    assert.deepEqual(validateSchema(schema, nolf), [], 'the contract-1 nolf-improved declaration is unchanged and valid');
    const one = await declare(directory, 'nolf', nolf);
    assert.equal(one.contract, 1); assert.equal(one.error, undefined);
    assert.equal(one.game, undefined); assert.equal(one.dashboard, undefined);
    assert.equal(one.gameError, undefined); assert.equal(one.dashboardError, undefined);
    assert.equal(matchFormat(one.formats, 'nolf/NOLF.REZ')?.id, 'lithtech-rez');

    const merged = fixture('nolf-merged-project.json');
    assert.deepEqual(validateSchema(schema, merged), [], 'the merged nolf-improved contract-2 document validates');
    const two = await declare(directory, 'nolf-merged', merged);
    assert.equal(two.contract, 2); assert.equal(two.error, undefined); assert.equal(two.dashboardError, undefined);
    assert.equal(two.dashboard.title, 'reLith'); assert.equal(two.game, undefined); assert.equal(two.gameError, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

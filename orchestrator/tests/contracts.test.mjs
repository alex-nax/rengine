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

    /* The shape vtmb-vr is expected to adopt: its two quick-start script actions become game
       actions on the record they already declare, the variant carrying only extra literal argv. */
    const asGameActions = structuredClone(vtmb);
    const quickStart = asGameActions.dashboard.groups.find(group => group.id === 'quick-start');
    quickStart.actions[0] = { id: 'flat', title: 'Flat desktop: main menu', kind: 'game', game: 'vtmb-flat' };
    quickStart.actions[1] = { id: 'flat-newgame', title: 'Flat desktop: new game', kind: 'game', game: 'vtmb-flat', args: ['--newgame'] };
    assert.deepEqual(validateSchema(schema, asGameActions), [], 'game actions over the declared records validate');
    const rewritten = await declare(directory, 'vtmb-game-actions', asGameActions);
    assert.equal(rewritten.dashboardError, undefined); assert.equal(rewritten.gamesError, undefined);
    assert.deepEqual(rewritten.dashboard.groups[0].actions.slice(0, 2).map(a => [a.kind, a.game, a.args]),
      [['game', 'vtmb-flat', undefined], ['game', 'vtmb-flat', ['--newgame']]]);
    /* The shape the owner will flip `vtmb-flat` to now that its engine speaks the surface protocol
       (spec 078, F77). Verified against a copy: this repository never edits a consumer's file. */
    const asCooperative = structuredClone(vtmb);
    asCooperative.games[0] = { id: 'vtmb-flat', title: 'VtMB', executable: ['build/vtmb', 'build/Release/vtmb'],
      args: ['--width', '1280', '--height', '720'], env: { VTMB_HIDDEN_WINDOW: '1' },
      requires: ['gamedata/Vampire/pack000.vpk'], surface: 'cooperative' };
    assert.deepEqual(validateSchema(schema, asCooperative), [], 'the cooperative shape validates structurally');
    const coop = await declare(directory, 'vtmb-cooperative', asCooperative);
    assert.equal(coop.error, undefined); assert.equal(coop.gamesError, undefined); assert.equal(coop.dashboardError, undefined);
    assert.deepEqual(coop.games.map(x => [x.id, x.surface]), [['vtmb-flat', 'cooperative'], ['vtmb-vr', 'external']]);
    /* The consumer's own variable is an ordinary declared entry: rEngine needs no knowledge of it,
       and the reserved-prefix rule (RENGINE_/DYLD_/LD_) does not reach a name like this one. */
    assert.deepEqual(coop.games[0].env, { VTMB_HIDDEN_WINDOW: '1' });
    assert.deepEqual(coop.games[0].args, ['--width', '1280', '--height', '720']);
    const reserved = structuredClone(asCooperative);
    reserved.games[0].env = { DYLD_INSERT_LIBRARIES: '/x.dylib' };
    assert.match((await declare(directory, 'vtmb-reserved', reserved)).gamesError, /DYLD_INSERT_LIBRARIES is reserved/);

    const stray = structuredClone(asGameActions);
    stray.dashboard.groups[0].actions[0].game = 'vtmb-nowhere';
    const unknown = await declare(directory, 'vtmb-stray', stray);
    assert.match(unknown.dashboardError, /references undeclared game id "vtmb-nowhere"; this declaration declares vtmb-flat, vtmb-vr/);
    assert.deepEqual(unknown.games.map(x => x.id), ['vtmb-flat', 'vtmb-vr'], 'the games array survives a bad reference');
    assert.equal(unknown.formats[0].id, 'troika-vpk');

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

/* Fail-whole plus the removed toolbar (spec 078) makes this message the only recovery path: it has
   to name the record a human greps for, not only the index they would have to count out. */
test('a declaration error names the offending record by id and says how much the report hides', async () => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-error-ids-')));
  try {
    const base = declaration();
    const badFormat = await declare(directory, 'format', { ...base, formats: [{ ...base.formats[0], modes: ['raw'], default: 'preview' }] });
    assert.match(badFormat.error, /\$\.formats\[0\] \(fixture-pack\)\.default must be one of its modes/);
    assert.deepEqual(badFormat.formats, [], 'a format cross-rule error still fails the section whole');

    const badGame = await declare(directory, 'game', { ...base, contract: 3, games: [game({ cwd: '../elsewhere' })] });
    assert.match(badGame.gamesError, /\$\.games\[0\] \(fixture-game\)\.cwd must be root-relative/);

    const board = groups => ({ ...base, contract: 2, dashboard: { title: 'Fixture', groups } });
    const shot = (extra = {}) => ({ id: 'shot', title: 'Screenshot', kind: 'capture', command: ['tools/shot.sh'], into: '/tmp/captures', format: 'png', ...extra });
    const group = (actions, extra = {}) => board([{ id: 'device', title: 'Device', actions, ...extra }]);

    const action = await declare(directory, 'action', group([shot()]));
    assert.match(action.dashboardError, /\$\.dashboard\.groups\[0\]\.actions\[0\] \(shot\)\.into must be root-relative/);

    const anonymous = await declare(directory, 'anonymous', group([shot({ id: undefined })]));
    assert.match(anonymous.dashboardError, /\$\.dashboard\.groups\[0\] \(device\)\.actions\[0\]\.into must be root-relative/, 'an unnamed action is placed by its group');
    assert.ok(!/undefined/.test(anonymous.dashboardError), 'a missing id is never printed as undefined');

    const nameless = await declare(directory, 'nameless', group([shot({ id: undefined })], { id: undefined }));
    assert.match(nameless.dashboardError, /\$\.dashboard\.groups\[0\]\.actions\[0\]\.into must be root-relative/, 'with no id anywhere the bare path stands alone');

    const duplicate = await declare(directory, 'duplicate', group([shot({ into: '.cache/captures' }), shot({ into: '.cache/captures' })]));
    assert.match(duplicate.dashboardError, /\$\.dashboard\.groups\[0\]\.actions\[1\]\.id repeats "shot"/, 'a duplicate id names the occurrence by index, never by the id it repeats');

    const counted = async (name, count) => (await declare(directory, name, group(Array.from({ length: count }, (_, i) => shot({ id: `shot-${i}` }))))).dashboardError;
    const three = await counted('three', 3);
    assert.match(three, /\(shot-0\).+\(shot-1\).+\(shot-2\)/); assert.ok(!/more/.test(three), 'a report that hides nothing says nothing');
    assert.match(await counted('four', 4), /; and 1 more problem$/);
    const five = await counted('five', 5);
    assert.match(five, /; and 2 more problems$/); assert.ok(!/shot-3/.test(five), 'the report stays bounded at three problems');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { declaration } from './format-fixtures.mjs';

// Shared fixtures for the per-project game declarations (contract 3, games array): scripts that
// print their argv, declared env and working directory, then idle until they are stopped.
export const game = (extra = {}) => ({
  id: 'fixture-game', title: 'Fixture game', executable: ['build/missing-game', 'tools/game.sh'],
  args: ['--flat', '--width', '640'], env: { FIXTURE_FLAVOUR: 'blue' }, requires: ['data/present.bin'], surface: 'external', ...extra,
});
export const second = (extra = {}) => ({
  id: 'fixture-second', title: 'Fixture second', executable: ['tools/second.sh'], args: ['--second'], surface: 'external', ...extra,
});
export const absent = (extra = {}) => ({ id: 'fixture-absent', title: 'Fixture absent', executable: ['build/absent-game'], surface: 'external', ...extra });
/* A game that speaks the surface protocol in its own process (spec 078, F77): nothing is injected
   into it, so it stands in for an SDL3-static consumer without the suite owning that consumer. */
export const cooperativeGame = (extra = {}) => ({
  id: 'fixture-cooperative', title: 'Fixture co-op', executable: ['tools/cooperative.sh'],
  args: ['--width', '8', '--height', '4'], env: { FIXTURE_FLAVOUR: 'violet' }, surface: 'cooperative', ...extra,
});
export const gamesDeclaration = (games, base = declaration()) => ({ ...base, contract: 3, games });
export const gameDeclaration = (extra = {}, base = declaration()) => gamesDeclaration([game(extra)], base);

// A dashboard of contract-3 game actions over the records above: a plain launch, the same record
// with an extra literal argument (the vtmb-vr --newgame shape), a second record, an unbuilt record
// and one gated by a tool that is never on PATH.
export const gameActions = (extra = {}) => ({ title: 'Fixture launcher', groups: [{ id: 'launch', title: 'Launch', actions: [
  { id: 'play', title: 'Play the fixture game', description: 'The declared record with no extra argv', kind: 'game', game: 'fixture-game' },
  { id: 'play-newgame', title: 'Play, skipping the menu', kind: 'game', game: 'fixture-game', args: ['--newgame'] },
  { id: 'play-second', title: 'Play the second game', kind: 'game', game: 'fixture-second' },
  { id: 'play-absent', title: 'Play the unbuilt game', kind: 'game', game: 'fixture-absent' },
  { id: 'play-needs-tool', title: 'Play once the tool is installed', kind: 'game', game: 'fixture-second', tools: ['definitely-missing-tool-9f'] },
] }], ...extra });
export const launcherDeclaration = (games = [game(), second(), absent()], board = gameActions()) => ({ ...gamesDeclaration(games), dashboard: board });

const script = marker => `#!/bin/bash\nprintf "${marker} args=%s flavour=%s cwd=%s\\n" "$*" "\${FIXTURE_FLAVOUR:-unset}" "$PWD"\n`
  + 'trap \'echo FIXTURE_GAME_EXIT; exit 0\' TERM\nfor i in $(seq 1 600); do sleep 0.1; done\n';
/* The declared executable of a cooperative record: a root-relative launcher, like a real one, over
   the committed producer beside this file. */
const producer = fileURLToPath(new URL('./surface-producer.mjs', import.meta.url));
const cooperativeScript = `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(producer)} "$@"\n`;

export async function gameProject(directory, name, document = gameDeclaration()) {
  const root = path.join(directory, name);
  for (const sub of ['.rengine', 'tools', 'data', 'work']) await mkdir(path.join(root, sub), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document));
  for (const [file, marker] of [['tools/game.sh', 'FIXTURE_GAME_STARTED'], ['tools/second.sh', 'FIXTURE_SECOND_STARTED']]) {
    await writeFile(path.join(root, file), script(marker));
    await chmod(path.join(root, file), 0o755);
  }
  await writeFile(path.join(root, 'tools/cooperative.sh'), cooperativeScript);
  await chmod(path.join(root, 'tools/cooperative.sh'), 0o755);
  await writeFile(path.join(root, 'data/present.bin'), Buffer.from([1, 2, 3]));
  return root;
}

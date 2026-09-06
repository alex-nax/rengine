import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
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
export const gamesDeclaration = (games, base = declaration()) => ({ ...base, contract: 3, games });
export const gameDeclaration = (extra = {}, base = declaration()) => gamesDeclaration([game(extra)], base);

const script = marker => `#!/bin/bash\nprintf "${marker} args=%s flavour=%s cwd=%s\\n" "$*" "\${FIXTURE_FLAVOUR:-unset}" "$PWD"\n`
  + 'trap \'echo FIXTURE_GAME_EXIT; exit 0\' TERM\nfor i in $(seq 1 600); do sleep 0.1; done\n';

export async function gameProject(directory, name, document = gameDeclaration()) {
  const root = path.join(directory, name);
  for (const sub of ['.rengine', 'tools', 'data', 'work']) await mkdir(path.join(root, sub), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document));
  for (const [file, marker] of [['tools/game.sh', 'FIXTURE_GAME_STARTED'], ['tools/second.sh', 'FIXTURE_SECOND_STARTED']]) {
    await writeFile(path.join(root, file), script(marker));
    await chmod(path.join(root, file), 0o755);
  }
  await writeFile(path.join(root, 'data/present.bin'), Buffer.from([1, 2, 3]));
  return root;
}

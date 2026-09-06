import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { declaration } from './format-fixtures.mjs';

// Shared fixtures for the per-project game declaration: a contract-2 document whose game is a
// script that prints its argv, declared env and cwd, then idles until it is stopped.
export const game = (extra = {}) => ({
  id: 'fixture-game', title: 'Fixture game', executable: ['build/missing-game', 'tools/game.sh'],
  args: ['--flat', '--width', '640'], env: { FIXTURE_FLAVOUR: 'blue' }, requires: ['data/present.bin'], surface: 'external', ...extra,
});
export const gameDeclaration = (extra = {}, base = declaration()) => ({ ...base, contract: 2, game: game(extra) });
export async function gameProject(directory, name, document = gameDeclaration()) {
  const root = path.join(directory, name);
  for (const sub of ['.rengine', 'tools', 'data']) await mkdir(path.join(root, sub), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document));
  await writeFile(path.join(root, 'tools/game.sh'), '#!/bin/bash\nprintf "FIXTURE_GAME_STARTED args=%s flavour=%s cwd=%s\\n" "$*" "${FIXTURE_FLAVOUR:-unset}" "$PWD"\n'
    + 'trap \'echo FIXTURE_GAME_EXIT; exit 0\' TERM\nfor i in $(seq 1 600); do sleep 0.1; done\n');
  await chmod(path.join(root, 'tools/game.sh'), 0o755);
  await writeFile(path.join(root, 'data/present.bin'), Buffer.from([1, 2, 3]));
  return root;
}

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(root, '.cache/desktop');
const args = ['-S', root, '-B', build, '-DCMAKE_BUILD_TYPE=Release'];
for (const command of [args, ['--build', build, '--config', 'Release', '--parallel', '6']]) {
  const result = spawnSync('cmake', command, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native desktop build failed (${result.status}).`);
}

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(root, '.cache/desktop');
const args = ['-S', root, '-B', build, '-DCMAKE_BUILD_TYPE=Release', `-DRENGINE_NODE_EXECUTABLE=${process.execPath}`];
await mkdir(build, { recursive: true });
const lockPath = path.join(build, 'build.lock'), deadline = Date.now() + 180000; let lock;
while (!lock) {
  try { lock = await open(lockPath, 'wx', 0o600); await lock.writeFile(JSON.stringify({ pid: process.pid })); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const owner = JSON.parse(await readFile(lockPath, 'utf8'));
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') { await rm(lockPath, { force: true }); continue; } }
      }
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (Date.now() > deadline) throw new Error('Another native build still owns build.lock; no competing build was started.');
    await delay(100);
  }
}
try {
  for (const command of [args, ['--build', build, '--config', 'Release', '--parallel', '6']]) {
    const result = spawnSync('cmake', command, { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Native desktop build failed (${result.status}).`);
  }
} finally { await lock.close(); await rm(lockPath, { force: true }); }

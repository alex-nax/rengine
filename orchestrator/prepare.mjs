import { chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const relative of [`prebuilds/${process.platform}-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
    const file = path.join(root, relative);
    try {
      const mode = (await stat(file)).mode;
      if (!(mode & 0o100)) { await chmod(file, mode | 0o111); console.log(`Prepared executable PTY helper: ${relative}`); }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

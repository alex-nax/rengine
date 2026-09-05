import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(`${root}/dist`, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['orchestrator/ui/app.jsx'], bundle: true, outfile: 'dist/app.js',
  sourcemap: true, minify: false, target: 'chrome140', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file' } });
await copyFile(`${root}/orchestrator/ui/index.html`, `${root}/dist/index.html`);

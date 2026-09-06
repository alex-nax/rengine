import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Shared fixtures for the project format registry: a declaration, a pack producer and sample entries.
export const producer = path.resolve('orchestrator/tests/pack-producer.mjs');
export const pack = manifest => Buffer.concat([Buffer.from('PACK\0', 'latin1'), Buffer.from(JSON.stringify(manifest))]);
export const declaration = (extra = {}) => ({ contract: 1, project: 'fixture', formats: [{
  id: 'fixture-pack', title: 'Fixture pack', match: ['*.pack'], modes: ['raw', 'preview'], default: 'raw',
  preview: { kind: 'tree', command: [process.execPath, producer, 'tree', '${file}'], timeoutMs: 4000, maxBytes: 65536 },
  entry: { kind: 'bytes', command: [process.execPath, producer, 'cat', '${file}', '${entry}'], timeoutMs: 4000, maxBytes: 65536 },
  ...extra,
}] });
export const entries = { 'readme.txt': 'hello pack\n', 'Worlds/t01.dat': { base64: Buffer.from([0, 1, 2, 255, 254, 253]).toString('base64') }, 'Worlds/sub/model.abc': 'ABC model', 'odd $(name).txt': 'literal' };
export async function project(directory, name, extra) {
  const root = path.join(directory, name); await mkdir(path.join(root, '.rengine'), { recursive: true });
  if (extra !== null) await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(declaration(extra)));
  await writeFile(path.join(root, 'sample.pack'), pack({ entries }));
  return root;
}

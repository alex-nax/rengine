import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { declaration } from './format-fixtures.mjs';

export const captureProducer = path.resolve('orchestrator/tests/capture-producer.mjs');
export const dashboard = (extra = {}) => ({ title: 'Fixture', groups: [
  { id: 'build', title: 'Build', actions: [
    { id: 'hello', title: 'Say hello', description: 'Echoes its argument and environment', kind: 'script', script: 'hello.sh', args: ['--fast'], env: { BUILD_TYPE: 'RELEASE' }, artifacts: ['dist/out.txt'] },
    { id: 'needs-file', title: 'Needs a file', kind: 'script', script: 'hello.sh', requires: ['missing.env'] },
    { id: 'needs-tool', title: 'Needs a tool', kind: 'script', script: 'hello.sh', tools: ['definitely-missing-tool-9f'] },
    { id: 'has-tool', title: 'Has a tool', kind: 'script', script: 'hello.sh', tools: ['sh'] },
  ] },
  { id: 'device', title: 'Device', actions: [
    { id: 'logger', title: 'Log stream', kind: 'log', command: [process.execPath, '-e', "console.log('LOG_LINE'); setTimeout(() => {}, 3000)"], filters: ['LOG'] },
    { id: 'shot', title: 'Screenshot', kind: 'capture', command: [process.execPath, captureProducer, 'png'], into: '.cache/captures', format: 'png' },
    { id: 'bad-shot', title: 'Text instead of PNG', kind: 'capture', command: [process.execPath, captureProducer, 'text'], into: '.cache/captures', format: 'png' },
    { id: 'failing-shot', title: 'Failing capture', kind: 'capture', command: [process.execPath, captureProducer, 'fail'], into: '.cache/captures', format: 'png' },
    { id: 'escape-shot', title: 'Escaping capture', kind: 'capture', command: [process.execPath, captureProducer, 'png'], into: 'captures-link', format: 'png' },
  ] },
], ...extra });
export const contract2 = (extra = {}) => ({ ...declaration(), contract: 2, dashboard: dashboard(), ...extra });
export async function dashboardProject(directory, name, document = contract2()) {
  const root = path.join(directory, name); await mkdir(path.join(root, '.rengine'), { recursive: true }); await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document));
  await writeFile(path.join(root, 'hello.sh'), '#!/bin/bash\nprintf "HELLO ARG=%s ENV=%s PWD_OK=%s\\n" "$1" "${BUILD_TYPE:-unset}" "$([ "$PWD" = "$(cd "$(dirname "$0")" && pwd)" ] && echo yes || echo no)"\nsleep 2\n');
  await chmod(path.join(root, 'hello.sh'), 0o755);
  await writeFile(path.join(root, 'dist/out.txt'), 'artifact\n');
  return root;
}

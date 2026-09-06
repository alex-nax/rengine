import { spawn } from 'node:child_process';
import { mkdir, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const project = fileURLToPath(new URL('../../', import.meta.url));
export const nativeBinary = path.join(project, '.cache/desktop/bin', process.platform === 'win32' ? 'Release/rengine.exe' : 'rengine');
export function run(command, args, { env = process.env, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; const record = data => { output = (output + data).slice(-16000); };
    child.stdout.on('data', record); child.stderr.on('data', record);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Update command timed out: ${command}\n${output}`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(`Update command failed (${code ?? signal}):\n${output}`)); });
  });
}
export async function snapshotBinary(binary, directory) {
  const destination = path.join(directory, 'bin'); await mkdir(destination, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') await cp(path.dirname(binary), destination, { recursive: true });
  else await cp(binary, path.join(destination, path.basename(binary)));
  return path.join(destination, path.basename(binary));
}
export async function prepareDesktop(directory) {
  await run(process.execPath, [path.join(project, 'orchestrator/build.mjs')]);
  const binary = await snapshotBinary(nativeBinary, directory);
  await run(binary, ['--smoke-test'], { env: { ...process.env, RENGINE_LAYERED_CHILD: '1',
    RENGINE_WORKSPACE_URL: '', RENGINE_WORKSPACE_TOKEN: '', RENGINE_INITIAL_ROOT: '',
    RENGINE_INITIAL_TERMINAL: '', RENGINE_INITIAL_AGENT: '', RENGINE_INITIAL_GAME: '' }, timeout: 15000 });
  return binary;
}
export function launchDesktop(binary, instance, binding, { inspectUI = false } = {}) {
  return spawn(binary, inspectUI ? ['--automation'] : ['--control'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: false, env: {
    ...process.env, RENGINE_WORKSPACE_URL: instance.url, RENGINE_WORKSPACE_TOKEN: instance.token,
    RENGINE_WINDOW_ID: binding.windowId, RENGINE_WINDOW_TITLE: binding.title, RENGINE_INITIAL_ROOT: binding.root, RENGINE_INITIAL_TERMINAL: binding.terminal ?? '',
    RENGINE_INITIAL_AGENT: binding.agent ?? '', RENGINE_INITIAL_GAME: binding.game ?? '',
    RENGINE_RESUME_AGENT: binding.resume ? '1' : undefined, RENGINE_LAYERED_CHILD: '1',
    RENGINE_CAN_RELOAD: '1', RENGINE_DESKTOP_OWNER: binding.owner, RENGINE_DESKTOP_VIEW: binding.view,
  } });
}

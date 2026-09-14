/* The thin client of `red_project::preview` and the declaration reader (F156, spec 129).
 *
 * What a project declares about itself, and what its own producer says about one of its files, are
 * one implementation now — `red/red-project/` — judged against the answers this module used to give
 * (`orchestrator/tests/preview-corpus.json`). A refusal comes back as `{error, status}` and is
 * thrown as the same `fail()` this module threw, so a route answers the status it always answered.
 *
 * What stayed is `runCommand`: a dashboard CAPTURE still runs a project's command here, because the
 * bytes it produces are written into the project by `dashboard.mjs`. It goes with that write.
 */
import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { resolveInRoot } from './store-client.mjs';
import { askProject } from './project-client.mjs';
import { shellEnvironment } from './sessions-client.mjs';

const MAX_STDERR = 16 * 1024;
const PLACEHOLDER = /\$\{(file|entry|host|selector|json)\}/g; /* host/selector only reach here from a device probe and json only from a task write; the schema permits each nowhere else */

/* A root registered with a declaration file of its own is read from THAT file, not from the
   project's — an external declaration describes a project this workspace does not own. */
const declarationOf = root => (typeof root === 'object' && root.declarationFile !== undefined ? root.declarationFile : '');

export async function readDeclaration(root) {
  return askProject(['declaration', typeof root === 'string' ? root : root.path, declarationOf(root)]);
}

export async function listFormats(root) { return { rootId: root.id, ...await readDeclaration(root) }; }

/* The environment a declared command runs in is the SHELL's, as it was when this module spawned it
   itself: `shellEnvironment()` is what adds TERM and COLORTERM and drops the launcher's own marker,
   and a project's producer sees the same environment either side of the port. */
export async function formatPreview(root, data) {
  return askProject(['preview', root.id, root.path, declarationOf(root)], JSON.stringify(data), shellEnvironment());
}

export async function readBytes(root, data) {
  return askProject(['bytes', root.id, root.path], JSON.stringify(data));
}

async function resolveExecutable(rootPath, argv0) {
  if (path.isAbsolute(argv0) || !/[\\/]/.test(argv0)) return argv0;
  const resolved = path.resolve(rootPath, argv0);
  if (process.platform === 'win32') { try { await access(resolved); } catch { try { await access(`${resolved}.exe`); return `${resolved}.exe`; } catch { /* report the declared name */ } } }
  return resolved;
}
function terminate(child) {
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } } }
  child.stdout.destroy(); child.stderr.destroy();
}
export async function runCommand(root, spec, values) {
  const file = values.file === undefined ? null : await resolveInRoot(root, values.file); /* re-confined immediately before spawn; see sidecar: execution-boundary */
  const argv = spec.command.map(arg => arg.replace(PLACEHOLDER, (match, key) => key === 'file' ? (file ? file.absolute : match) : values[key] ?? match));
  argv[0] = await resolveExecutable(root.path, argv[0]);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: root.path, env: shellEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
    const chunks = []; let size = 0, stderr = '', done = false, timer;
    const exited = new Promise(settle => child.once('exit', settle));
    const firstLine = () => stderr.split(/\r?\n/).find(line => line.trim())?.trim() ?? '';
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer);
      if (!error) { resolve(value); return; }
      if (child.exitCode === null && child.signalCode === null) terminate(child);
      Promise.race([exited, delay(1000)]).then(() => reject(error));
    };
    const failure = (message, status) => finish(Object.assign(new Error(message), { status }));
    timer = setTimeout(() => failure(`Command timed out after ${spec.timeoutMs} ms${firstLine() ? `: ${firstLine()}` : ''}`, 504), spec.timeoutMs);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > spec.maxBytes) failure(`Command output exceeded ${spec.maxBytes} bytes.`, 413); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-MAX_STDERR); });
    child.once('error', error => failure(`Cannot start ${argv[0]}: ${error.message}`, 500));
    child.once('close', (code, signal) => {
      if (code === 0) finish(null, { argv, stdout: Buffer.concat(chunks), durationMs: Date.now() - started });
      else failure(`Command failed (${code === null ? signal : `exit ${code}`})${firstLine() ? `: ${firstLine()}` : ' with no diagnostic.'}`, 502);
    });
  });
}

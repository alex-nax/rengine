import { spawn, execFile } from 'node:child_process';
import { readFile, stat, open, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fail, hash, resolveInRoot, MAX_TEXT_BYTES } from './store-client.mjs';
import { askProject } from './project-client.mjs';
import { shellEnvironment } from './sessions-client.mjs';

/* A provider only accepts the locator it can use, so a declaration that names the wrong one is
   refused at declaration time rather than failing later against the network. */

/* The agent/model menu a project offers (spec 103 decision 8). A default outside its own models is a
   menu whose first choice is not on it, and two records for one CLI make the chooser ambiguous. */

/* One pinned, versioned artifact whose facets say how it is consumed (charter D39, spec 107): a
   library facet at build time, a plugin facet at run time, or both. The pack is DECLARED here and
   acquired nowhere — no path is opened and no revision is checked against bytes, because
   identifying bytes is acquisition and KI-008 has not decided it. */

export const CONTRACTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
/* Brand-mark colours a project may name. Each is a saturated fill the design system pairs with
   the on-accent ink, which is what keeps the letter legible in every preset. */
export const ICON_TOKENS = ['accent', 'ok', 'warn', 'err', 'info'];
export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_RAW_WINDOW = 64 * 1024;
const MAX_DECLARATION_BYTES = 256 * 1024, MAX_TREE_DEPTH = 64, MAX_TREE_NODES = 200000, MAX_STDERR = 16 * 1024;
const PLACEHOLDER = /\$\{(file|entry|host|selector|json)\}/g; /* host/selector only reach here from a device probe and json only from a task write; the schema permits each nowhere else */


/* Contract 10 (spec 117). The declaration only names the file; its contents are the project's
   artifact and are read where the rows are built, not here. The path is confined the way every other
   declared path is, because a manifest outside the root is not this project describing itself. */
/* The declaration reader is `red-project`'s (F156b): the contract document, the contract floors, the
   artwork resolution and every section rule are one implementation now, and this asks it. What
   stayed in this file is what runs a project's own commands — a preview, an entry, a byte window —
   which is the other half of what a format is for.

   A refusal comes back as `{error, status}` and is thrown as the same `fail()` the reader threw, so
   a route answers the status it always answered. */
export async function readDeclaration(root) {
  const rootPath = typeof root === 'string' ? root : root.path;
  const external = typeof root === 'object' && root.declarationFile !== undefined;
  return askProject(['declaration', rootPath, external ? root.declarationFile : '']);
}

export async function listFormats(root) { return { rootId: root.id, ...await readDeclaration(root) }; }

function globToRegExp(glob) {
  const source = glob.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\[!/g, '[^');
  try { return new RegExp(`^${source}$`, 'i'); } catch { return new RegExp(`^${glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'); }
}
export function matchFormat(formats, name) {
  const base = path.posix.basename(name);
  return formats.find(format => format.match.some(glob => globToRegExp(glob).test(base))) ?? null;
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

function decodeText(bytes) {
  if (bytes.length > MAX_TEXT_BYTES || bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}
function windowOf(bytes, offset = 0, length = MAX_RAW_WINDOW) {
  offset = Number(offset); length = Number(length);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) fail('Byte window needs non-negative integer offset and length.');
  const slice = bytes.subarray(Math.min(offset, bytes.length), Math.min(offset + Math.min(length, MAX_RAW_WINDOW), bytes.length));
  return { offset, length: slice.length, hex: slice.toString('hex') };
}
function sanitizeTree(value) {
  let nodes = 0;
  const bad = () => fail('Preview output is not one JSON tree object.', 502);
  const node = (item, depth) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !Array.isArray(item.dirs) || !Array.isArray(item.files) || depth > MAX_TREE_DEPTH) bad();
    if ((nodes += 1 + item.files.length) > MAX_TREE_NODES) fail('Preview tree exceeds 200,000 nodes.', 413);
    return { name: typeof item.name === 'string' ? item.name : '', dirs: item.dirs.map(child => node(child, depth + 1)), files: item.files.map(file => {
      if (!file || typeof file.name !== 'string' || typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0) bad();
      return { name: file.name, path: file.path, size: file.size };
    }) };
  };
  return node(value, 0);
}

export async function formatPreview(root, data) {
  const declared = await readDeclaration(root);
  if (!declared.declared) fail('This project does not declare formats in .rengine/project.json.', 415);
  if (declared.error) fail(declared.error, 415);
  const file = await resolveInRoot(root, data.path);
  if (!(await stat(file.absolute)).isFile()) fail('Previews require a regular file.', 415);
  let format;
  if (data.formatId !== undefined) format = declared.formats.find(x => x.id === data.formatId) ?? fail('Unknown formatId for this project.', 404);
  else format = matchFormat(declared.formats, file.relative) ?? fail(`No registered format matches ${path.posix.basename(file.relative)}.`, 415);
  const base = { format: format.id, title: format.title, path: file.relative };
  if (data.entry !== undefined) {
    if (typeof data.entry !== 'string' || !data.entry.length || data.entry.length > 4096 || data.entry.includes('\0')) fail('Entry must be a bounded string.');
    if (!format.entry) fail(`Format ${format.id} declares no entry command.`, 415);
    const run = await runCommand(root, format.entry, { file: file.relative, entry: data.entry }), text = decodeText(run.stdout);
    return { kind: 'entry', ...base, entry: data.entry, command: run.argv, durationMs: run.durationMs, size: run.stdout.length, sha256: hash(run.stdout),
      ...(text !== null ? { text } : {}), window: windowOf(run.stdout, data.offset, data.length) };
  }
  if (!format.preview) fail(`Format ${format.id} declares no preview command.`, 415);
  const run = await runCommand(root, format.preview, { file: file.relative });
  const result = { kind: format.preview.kind, ...base, command: run.argv, durationMs: run.durationMs, bytes: run.stdout.length };
  if (format.preview.kind === 'text') {
    if (run.stdout.length > MAX_TEXT_BYTES) fail('Preview text exceeds 2 MiB.', 413);
    const text = decodeText(run.stdout); if (text === null) fail('Preview output is not UTF-8 text without NUL.', 502);
    return { ...result, text };
  }
  let parsed; try { parsed = JSON.parse(run.stdout.toString('utf8')); } catch { fail('Preview output is not one JSON tree object.', 502); }
  return { ...result, tree: sanitizeTree(parsed) };
}

export async function readBytes(root, { path: relative, offset = 0, length = MAX_RAW_WINDOW }) {
  offset = Number(offset); length = Number(length);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) fail('Byte window needs non-negative integer offset and length.');
  const file = await resolveInRoot(root, relative);
  const handle = await open(file.absolute, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) fail('Raw view requires a regular file.', 415);
    const current = await stat((await resolveInRoot(root, relative)).absolute); /* confine what was actually opened */
    if (current.dev !== info.dev || current.ino !== info.ino) fail('File changed during the read. Refresh to retry.', 409);
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, MAX_RAW_WINDOW, info.size - Math.min(offset, info.size))));
    let read = 0;
    while (read < buffer.length) { const result = await handle.read(buffer, read, buffer.length - read, offset + read); if (!result.bytesRead) break; read += result.bytesRead; }
    return { rootId: root.id, path: file.relative, size: info.size, modified: info.mtimeMs, offset, length: read, hex: buffer.subarray(0, read).toString('hex') };
  } finally { await handle.close(); }
}

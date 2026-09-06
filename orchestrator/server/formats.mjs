import { spawn, execFile } from 'node:child_process';
import { readFile, stat, open, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { validateSchema } from './schema.mjs';
import { fail, hash, resolveInRoot, MAX_TEXT_BYTES } from './store.mjs';
import { shellEnvironment } from './sessions.mjs';
import { dashboardRules, nameOf } from './dashboard-rules.mjs';
import { gamesRules } from './game-rules.mjs';

export const CONTRACTS = [1, 2, 3];
export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_RAW_WINDOW = 64 * 1024;
const MAX_DECLARATION_BYTES = 256 * 1024, MAX_TREE_DEPTH = 64, MAX_TREE_NODES = 200000, MAX_STDERR = 16 * 1024;
const PLACEHOLDER = /\$\{(file|entry)\}/g;
const schema = JSON.parse(await readFile(new URL('../../contracts/project-v1.schema.json', import.meta.url), 'utf8'));

const uses = (spec, name) => Array.isArray(spec?.command) && spec.command.some(arg => typeof arg === 'string' && arg.includes(`\${${name}}`));
function crossRules(value) {
  const errors = [], seen = new Set();
  if (!Array.isArray(value.formats)) return errors;
  for (const [index, format] of value.formats.entries()) {
    if (!format || typeof format !== 'object' || Array.isArray(format)) continue;
    const at = `$.formats[${index}]`, where = at + nameOf(format);
    if (seen.has(format.id)) errors.push(`${at}.id repeats ${JSON.stringify(format.id)}`); seen.add(format.id);
    if (Array.isArray(format.modes) && !format.modes.includes(format.default)) errors.push(`${where}.default must be one of its modes`);
    if (Array.isArray(format.modes) && format.modes.includes('preview') && !format.preview) errors.push(`${where}.preview is required for the preview mode`);
    if (Array.isArray(format.preview?.command) && !uses(format.preview, 'file')) errors.push(`${where}.preview.command must name \${file}`);
    if (Array.isArray(format.entry?.command) && !(uses(format.entry, 'file') && uses(format.entry, 'entry'))) errors.push(`${where}.entry.command must name \${file} and \${entry}`);
  }
  return errors;
}
const REPORTED = 3; /* one clipped line in two desktop surfaces; see sidecar: bounded-report */
const report = problems => problems.length > REPORTED
  ? `${problems.slice(0, REPORTED).join('; ')}; and ${problems.length - REPORTED} more problem${problems.length - REPORTED === 1 ? '' : 's'}`
  : problems.join('; ');
const bounded = spec => spec && { ...spec, timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBytes: spec.maxBytes ?? DEFAULT_MAX_BYTES };

export async function readDeclaration(rootPath) {
  const problem = message => ({ declared: true, error: `.rengine/project.json: ${message}`, formats: [] });
  let bytes;
  try { bytes = await readFile(path.join(rootPath, '.rengine', 'project.json')); }
  catch (error) { return error.code === 'ENOENT' ? { declared: false, formats: [] } : problem(`cannot read (${error.message})`); }
  if (bytes.length > MAX_DECLARATION_BYTES) return problem('declaration exceeds 256 KiB');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (error) { return problem(`invalid JSON (${error.message})`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return problem('declaration must be a JSON object');
  if (!CONTRACTS.includes(value.contract)) return problem(`unknown contract ${JSON.stringify(value.contract)}; this rEngine supports contracts ${CONTRACTS.slice(0, -1).join(', ')} and ${CONTRACTS.at(-1)}`);
  const { dashboard, games, ...base } = value;
  const structural = validateSchema(schema, base);
  if (structural.length) return problem(report(structural));
  const errors = crossRules(base);
  if (errors.length) return problem(report(errors));
  const result = { declared: true, contract: value.contract, project: value.project,
    formats: value.formats.map(format => ({ ...format, preview: bounded(format.preview), entry: bounded(format.entry) })) };
  /* games and dashboard are each reported separately so neither can disable the formats; see sidecar: declaration-reporting */
  return section(section(result, 'games', games, value.contract), 'dashboard', dashboard, value.contract);
}
const SECTIONS = {
  games: { minimum: 3, rules: gamesRules, node: () => schema.properties.games },
  dashboard: { minimum: 2, rules: dashboardRules, node: () => schema.$defs.dashboard },
};
function section(result, name, block, contract) {
  if (block === undefined) return result;
  const { minimum, rules, node } = SECTIONS[name], key = `${name}Error`;
  if (contract < minimum) return { ...result, [key]: `.rengine/project.json: ${name} requires contract ${minimum} (declared contract ${contract})` };
  const problems = [...validateSchema(node(), block, schema, `$.${name}`), ...rules(block, result)]; /* games is settled first, so dashboard rules can resolve game references */
  return problems.length ? { ...result, [key]: `.rengine/project.json: ${report(problems)}` } : { ...result, [name]: block };
}
export async function listFormats(root) { return { rootId: root.id, ...await readDeclaration(root.path) }; }

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
  const declared = await readDeclaration(root.path);
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

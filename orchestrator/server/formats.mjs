import { spawn, execFile } from 'node:child_process';
import { readFile, stat, open, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { validateSchema } from './schema.mjs';
import { fail, hash, resolveInRoot, MAX_TEXT_BYTES } from './store.mjs';
import { shellEnvironment } from './sessions.mjs';
import { dashboardRules, nameOf, rootRelative } from './dashboard-rules.mjs';
import { gamesRules } from './game-rules.mjs';
import { devicesRules } from './device-rules.mjs';

/* A provider only accepts the locator it can use, so a declaration that names the wrong one is
   refused at declaration time rather than failing later against the network. */
function languageServerRules(block, result = {}) {
  const problems = [], seen = new Set();
  for (const [index, server] of block.entries()) {
    if (seen.has(server.id)) problems.push(`$.languageServers[${index}] repeats id ${server.id}`);
    seen.add(server.id);
  }
  return problems;
}

function trackerRules(block, result = {}) {
  const problems = [];
  const need = { github: 'repository', linear: 'team' };
  const required = need[block.provider];
  if (required && block[required] === undefined) problems.push(`$.tracker requires ${required} for provider ${block.provider}`);
  for (const [provider, key] of Object.entries(need)) {
    if (block.provider !== provider && block[key] !== undefined) problems.push(`$.tracker ${key} belongs to provider ${provider}`);
  }
  if (block.provider !== 'local' && block.inventory !== undefined) problems.push('$.tracker inventory belongs to provider local');
  /* The narrowing keys are Linear's alone. A backend that cannot honour a declared filter refuses it
     by name rather than ignoring it, because a list that quietly answers a wider question than the
     one asked looks exactly like a correct answer (spec 100 decision 4). */
  for (const key of ['project', 'assignee', 'states']) {
    if (block.provider !== 'linear' && block[key] !== undefined) problems.push(`$.tracker ${key} belongs to provider linear`);
  }
  /* The one key of this block that is written rather than read (spec 103 decision 8). Its floor is
     checked here rather than through SECTIONS, because the block is contract 5 and only this key is
     contract 6; without it a contract-5 project would have the key accepted in silence. */
  if (block.write !== undefined) {
    if (block.provider !== 'local') problems.push('$.tracker write belongs to provider local');
    if (result.contract < 6) problems.push(`$.tracker write requires contract 6 (declared contract ${result.contract})`);
    if (Array.isArray(block.write) && !block.write.some(argument => typeof argument === 'string' && argument.includes('${json}'))) {
      problems.push('$.tracker.write must name ${json} in one of its arguments');
    }
  }
  return problems;
}
/* The agent/model menu a project offers (spec 103 decision 8). A default outside its own models is a
   menu whose first choice is not on it, and two records for one CLI make the chooser ambiguous. */
function agentsRules(value) {
  const problems = [], seen = new Set();
  if (!Array.isArray(value.agents)) return problems;
  for (const [index, record] of value.agents.entries()) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const at = `$.agents[${index}]`;
    if (seen.has(record.cli)) problems.push(`${at}.cli repeats ${JSON.stringify(record.cli)}`);
    seen.add(record.cli);
    if (Array.isArray(record.models) && !record.models.includes(record.default)) problems.push(`${at}.default must be one of its models`);
  }
  return problems;
}

export const CONTRACTS = [1, 2, 3, 4, 5, 6, 7, 8];
/* Brand-mark colours a project may name. Each is a saturated fill the design system pairs with
   the on-accent ink, which is what keeps the letter legible in every preset. */
export const ICON_TOKENS = ['accent', 'ok', 'warn', 'err', 'info'];
export const DEFAULT_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_RAW_WINDOW = 64 * 1024;
const MAX_DECLARATION_BYTES = 256 * 1024, MAX_TREE_DEPTH = 64, MAX_TREE_NODES = 200000, MAX_STDERR = 16 * 1024;
const PLACEHOLDER = /\$\{(file|entry|host|selector|json)\}/g; /* host/selector only reach here from a device probe and json only from a task write; the schema permits each nowhere else */
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

export async function readDeclaration(root) {
  const rootPath = typeof root === 'string' ? root : root.path;
  const external = typeof root === 'object' && root.declarationFile !== undefined;
  const source = external ? root.declarationFile : '.rengine/project.json';
  const problem = message => ({ declared: true, source, error: `${source}: ${message}`, formats: [] });
  let bytes;
  try { bytes = await readFile(external ? source : path.join(rootPath, '.rengine', 'project.json')); }
  catch (error) { return error.code === 'ENOENT' && !external ? { declared: false, formats: [] } : problem(`cannot read (${error.message})`); }
  if (bytes.length > MAX_DECLARATION_BYTES) return problem('declaration exceeds 256 KiB');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (error) { return problem(`invalid JSON (${error.message})`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return problem('declaration must be a JSON object');
  if (!CONTRACTS.includes(value.contract)) return problem(`unknown contract ${JSON.stringify(value.contract)}; this rEngine supports contracts ${CONTRACTS.slice(0, -1).join(', ')} and ${CONTRACTS.at(-1)}`);
  const { dashboard, games, devices, tracker, ...base } = value;
  const structural = validateSchema(schema, base);
  if (structural.length) return problem(report(structural));
  /* Identity keys are plain root fields rather than a block, so their contract floor is checked here
     rather than through SECTIONS; without this a project on contract 4 would have them accepted in
     silence and wonder why the chrome never changed (spec 084). */
  for (const name of ['title', 'icon']) {
    if (value[name] !== undefined && value.contract < 5) {
      return problem(`${name} requires contract 5 (declared contract ${value.contract})`);
    }
  }
  /* Same reasoning one contract later: the agent/model menu is a plain root field (spec 103). */
  if (value.agents !== undefined && value.contract < 6) return problem(`agents requires contract 6 (declared contract ${value.contract})`);
  /* A token rather than a colour, so the mark's contrast against its ink is the design system's
     guarantee and not a per-project accident. Named here because the desktop must be able to resolve
     every value this accepts (spec 084 decision 5). */
  if (value.icon?.token !== undefined && !ICON_TOKENS.includes(value.icon.token)) {
    return problem(`icon token ${JSON.stringify(value.icon.token)} is not a design token; use ${ICON_TOKENS.join(', ')}`);
  }
  /* Brand artwork (spec 104). Same floor reasoning as the identity keys above, one contract later. */
  const artwork = [
    ...(value.icon?.image !== undefined ? [['icon.image', value.icon.image]] : []),
    ...(typeof value.wordmark === 'string' ? [['wordmark', value.wordmark]] : []),
    ...(value.wordmark && typeof value.wordmark === 'object'
      ? Object.entries(value.wordmark).map(([theme, file]) => [`wordmark.${theme}`, file]) : []),
  ];
  if (artwork.length && value.contract < 8) return problem(`brand artwork requires contract 8 (declared contract ${value.contract})`);
  /* Exactly one mark. Two, with no rule about which wins, is a defect waiting for a narrow window;
     neither leaves the chip with nothing to draw (spec 104 decision 4). */
  if (value.icon !== undefined) {
    const has = ['glyph', 'image'].filter(key => value.icon[key] !== undefined);
    if (has.length !== 1) return problem(`icon carries exactly one of glyph and image, not ${has.length ? has.join(' and ') : 'neither'}`);
  }
  /* Declaration-relative and confined, like every other project path — and an SVG, because that is
     the one format the chrome rasterises (spec 104 decisions 1 and 9). */
  for (const [where, file] of artwork) {
    if (!rootRelative(file)) return problem(`${where} must be a relative path inside the declaration's directory`);
    if (!file.toLowerCase().endsWith('.svg')) return problem(`${where} must name an .svg file`);
  }
  const errors = [...crossRules(base), ...agentsRules(base)];
  if (errors.length) return problem(report(errors));
  /* Brand artwork is resolved to an absolute file HERE, beside the declaration that names it, because
     that is the only place that knows where the declaration lives — an external one (spec 085) sits
     outside the root it describes. The desktop is handed a path it can open, never a path it has to
     join. A file that is missing or unreadable is reported and its path omitted, so the chrome falls
     back to its glyph rather than drawing nothing (spec 104 decision 7). */
  const artworkDir = external ? path.dirname(source) : rootPath;
  const artworkProblems = [];
  const resolveArtwork = async (where, file) => {
    const absolute = path.resolve(artworkDir, file);
    try { await access(absolute); return absolute; }
    catch { artworkProblems.push(`${where} names ${file}, which cannot be read`); return undefined; }
  };
  const withFile = (key, file) => (file === undefined ? {} : { [key]: file });
  const icon = value.icon?.image !== undefined
    ? { ...value.icon, ...withFile('imageFile', await resolveArtwork('icon.image', value.icon.image)) }
    : value.icon;
  const wordmark = typeof value.wordmark === 'string'
    ? { light: value.wordmark, dark: value.wordmark }
    : value.wordmark;
  const wordmarkFiles = wordmark
    ? { ...withFile('lightFile', await resolveArtwork('wordmark.light', wordmark.light)),
        ...withFile('darkFile', await resolveArtwork('wordmark.dark', wordmark.dark)) }
    : undefined;
  const result = { declared: true, source, contract: value.contract, project: value.project,
    ...(value.title !== undefined ? { title: value.title } : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(wordmark !== undefined ? { wordmark: { ...wordmark, ...wordmarkFiles } } : {}),
    ...(artworkProblems.length ? { artworkError: `${source}: ${report(artworkProblems)}` } : {}),
    ...(value.agents !== undefined ? { agents: value.agents } : {}),
    formats: value.formats.map(format => ({ ...format, preview: bounded(format.preview), entry: bounded(format.entry) })) };
  /* devices, games and dashboard are each reported separately so none can disable the formats, and
     devices settles first so both of the others can resolve a device binding; see sidecar: declaration-reporting */
  const withServers = section(result, 'languageServers', value.languageServers, value.contract);
  const withTracker = section(withServers, 'tracker', tracker, value.contract);
  const withDevices = section(withTracker, 'devices', devices, value.contract);
  return section(section(withDevices, 'games', games, value.contract), 'dashboard', dashboard, value.contract);
}
const SECTIONS = {
  languageServers: { minimum: 7, rules: languageServerRules, node: () => schema.properties.languageServers },
  tracker: { minimum: 5, rules: trackerRules, node: () => schema.properties.tracker },
  devices: { minimum: 4, rules: devicesRules, node: () => schema.properties.devices },
  games: { minimum: 3, rules: gamesRules, node: () => schema.properties.games },
  dashboard: { minimum: 2, rules: dashboardRules, node: () => schema.$defs.dashboard },
};
function section(result, name, block, contract) {
  if (block === undefined) return result;
  const { minimum, rules, node } = SECTIONS[name], key = `${name}Error`;
  if (contract < minimum) return { ...result, [key]: `${result.source}: ${name} requires contract ${minimum} (declared contract ${contract})` };
  const problems = [...validateSchema(node(), block, schema, `$.${name}`), ...rules(block, result)]; /* devices settle before games, and games before dashboard, so each can resolve the references it makes */
  return problems.length ? { ...result, [key]: `${result.source}: ${report(problems)}` } : { ...result, [name]: block };
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

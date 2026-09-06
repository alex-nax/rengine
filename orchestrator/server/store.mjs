import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
const key = (rootId, file) => JSON.stringify([rootId, file]);
const within = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
export async function resolveInRoot(root, relative = '', allowMissing = false) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) fail('Use a path relative to its project root.');
  const target = path.resolve(root.path, relative);
  if (!within(root.path, target)) fail('File is outside the selected project root.', 403);
  let resolved;
  try { resolved = await realpath(target); }
  catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    resolved = path.join(await realpath(path.dirname(target)), path.basename(target));
  }
  if (!within(root.path, resolved)) fail('Symlink points outside the selected project root.', 403);
  return { absolute: resolved, relative: path.relative(root.path, resolved).split(path.sep).join('/') };
}

export class WorkspaceStore {
  static async open(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new WorkspaceStore(directory);
    try {
      store.state = JSON.parse(await readFile(store.filename, 'utf8'));
      if (store.state.version !== 1 || !Array.isArray(store.state.roots) || typeof store.state.drafts !== 'object' || !store.state.drafts) {
        fail('Unsupported or damaged workspace state. Preserve the file before repairing it.', 500);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return store;
  }

  constructor(directory) {
    this.directory = directory;
    this.filename = path.join(directory, 'workspace.json');
    this.state = { version: 1, roots: [], drafts: {}, layout: null, preferences: {} };
    this.persisting = Promise.resolve();
    this.files = new Map();
  }

  persist() {
    const bytes = JSON.stringify(this.state, null, 2);
    const write = this.persisting.catch(() => {}).then(async () => {
      const temp = `${this.filename}.${randomUUID()}.tmp`;
      try { await writeFile(temp, bytes, { mode: 0o600 }); await rename(temp, this.filename); }
      finally { await rm(temp, { force: true }); }
    });
    this.persisting = write;
    return write;
  }

  async addRoot(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('Choose an absolute project directory.');
    const resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory()) fail('Project root must be a directory.');
    const existing = this.state.roots.find(root => root.path === resolved);
    if (existing) return existing;
    const root = { id: randomUUID(), path: resolved, name: path.basename(resolved) };
    this.state.roots.push(root);
    await this.persist();
    return root;
  }

  root(id) {
    const root = this.state.roots.find(item => item.id === id);
    if (!root) fail('Unknown project root.', 404);
    return root;
  }

  resolve(rootId, relative = '', allowMissing = false) { return resolveInRoot(this.root(rootId), relative, allowMissing); }

  async list(rootId, relative = '', hidden = false) {
    const file = await this.resolve(rootId, relative);
    const entries = (await readdir(file.absolute, { withFileTypes: true }))
      .filter(entry => hidden || !['.git', 'node_modules', '.cache', '.venv'].includes(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const shown = entries.slice(0, 2000);
    // Direct-child counts, which the tree shows beside a directory. One readdir per subdirectory is
    // only affordable on a listing small enough to be read at a glance, so a wide directory reports
    // none rather than paying for hundreds of syscalls nobody asked for.
    const directories = shown.filter(entry => entry.isDirectory());
    const counts = new Map();
    if (directories.length <= 100) {
      await Promise.all(directories.map(async entry => {
        try {
          const children = await readdir(path.join(file.absolute, entry.name), { withFileTypes: true });
          counts.set(entry.name, children.filter(child => hidden || !['.git', 'node_modules', '.cache', '.venv'].includes(child.name)).length);
        } catch { /* unreadable or vanished between the two reads: report no count */ }
      }));
    }
    return { path: file.relative, truncated: entries.length > 2000, entries: shown.map(entry => ({
      name: entry.name, path: [file.relative, entry.name].filter(Boolean).join('/'), directory: entry.isDirectory(), symlink: entry.isSymbolicLink(),
      ...(counts.has(entry.name) ? { children: counts.get(entry.name) } : {}),
    })) };
  }

  async readText(rootId, relative) {
    const file = await this.resolve(rootId, relative);
    const info = await stat(file.absolute);
    if (!info.isFile() || info.size > MAX_TEXT_BYTES) fail('Text editor supports files up to 2 MiB.');
    const bytes = await readFile(file.absolute);
    if (bytes.includes(0)) fail('Binary file cannot be opened as text.');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('File is not valid UTF-8 text.'); }
    const crlf = text.includes('\r\n');
    if (/\r(?!\n)/.test(text) || (crlf && /\n/.test(text.replaceAll('\r\n', '')))) fail('Mixed or legacy line endings require an external editor.');
    return { rootId, path: file.relative, text, version: hash(bytes), eol: crlf ? '\r\n' : '\n',
      bom: bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])), mode: info.mode,
      draft: this.getDraft(rootId, file.relative) };
  }

  getDraft(rootId, relative) { return this.state.drafts[key(rootId, relative)] ?? null; }

  async putDraft(draft) {
    if (typeof draft.text !== 'string' || Buffer.byteLength(draft.text) > MAX_TEXT_BYTES) fail('Draft exceeds the 2 MiB text limit.');
    if (draft.baseVersion !== null && typeof draft.baseVersion !== 'string') fail('Draft requires its base file version.');
    const file = await this.resolve(draft.rootId, draft.path, true);
    const record = { rootId: draft.rootId, path: file.relative, text: draft.text, baseVersion: draft.baseVersion, updatedAt: Date.now() };
    this.state.drafts[key(draft.rootId, file.relative)] = record;
    await this.persist();
    return record;
  }

  async discardDraft(rootId, relative) {
    this.root(rootId);
    delete this.state.drafts[key(rootId, relative)];
    await this.persist();
  }

  async saveText({ rootId, path: relative, text, version }) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT_BYTES) fail('Text exceeds the 2 MiB limit.');
    const file = await this.resolve(rootId, relative, true);
    const previous = this.files.get(file.absolute) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      let current;
      try { current = await this.readText(rootId, file.relative); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if ((current?.version ?? null) !== version) fail('File changed on disk. Reload or resolve the conflict before saving.', 409);
      const normalized = text.replaceAll('\r\n', '\n').replaceAll('\n', current?.eol ?? '\n');
      const bytes = `${current?.bom ? '\uFEFF' : ''}${normalized}`;
      const temp = path.join(path.dirname(file.absolute), `.rengine-save-${randomUUID()}`);
      try {
        await writeFile(temp, bytes, { mode: current?.mode ?? 0o644 });
        let latest = null;
        try { latest = hash(await readFile(file.absolute)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (latest !== version) fail('File changed on disk during Save. Your draft is preserved.', 409);
        await rename(temp, file.absolute);
      } finally { await rm(temp, { force: true }); }
      await this.discardDraft(rootId, file.relative);
      return this.readText(rootId, file.relative);
    });
    this.files.set(file.absolute, operation);
    try { return await operation; }
    finally { if (this.files.get(file.absolute) === operation) this.files.delete(file.absolute); }
  }

  async saveLayout(layout) {
    if (!layout || typeof layout !== 'object' || JSON.stringify(layout).length > 1024 * 1024) fail('Invalid workspace layout.');
    this.state.layout = layout;
    await this.persist();
  }

  async preferences(values) {
    if (!values || typeof values !== 'object') fail('Invalid preferences.');
    const { agent, vim } = values;
    if (agent !== undefined && (typeof agent !== 'string' || agent.length > 256)) fail('Invalid agent preference.');
    if (vim !== undefined && typeof vim !== 'boolean') fail('Invalid Vim preference.');
    this.state.preferences = { ...this.state.preferences, ...(agent !== undefined ? { agent } : {}), ...(vim !== undefined ? { vim } : {}) };
    await this.persist();
    return this.state.preferences;
  }
}

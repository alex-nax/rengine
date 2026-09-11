import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
const key = (rootId, file) => JSON.stringify([rootId, file]);
/* Game-recording ring bounds (spec 081): both apply, whichever binds first. The desktop clamps
   again, so a hand-edited workspace file cannot ask for a ring larger than these. */
const RECORDING = { seconds: [5, 900], bytes: [4 * 1024 * 1024, 1024 * 1024 * 1024], fps: [1, 30], width: [160, 1280], quality: [30, 95] };
/* Conversations are remembered per root because the host's own session list dies with the host,
   and surviving exactly that is the point of resuming into one. Bounded, most recent first. */
const CONVERSATION_LIMIT = 20;
const CONVERSATION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/* kimi names its own conversations; the shapes it resumes by (observed `session_<uuid>`, documented
   ULID) are accepted for a conversation recorded under kimi's own name and nobody else's. */
const KIMI_CONVERSATION_ID = /^(?:session_)?(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i;
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
    this.state = { version: 1, roots: [], drafts: {}, layout: null, preferences: {}, conversations: {} };
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

  async addRoot(directory, declarationFile) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('Choose an absolute project directory.');
    const resolved = await realpath(directory);
    if (!(await stat(resolved)).isDirectory()) fail('Project root must be a directory.');
    let declaration;
    if (declarationFile !== undefined) {
      if (typeof declarationFile !== 'string' || !path.isAbsolute(declarationFile)) fail('Choose an absolute declaration file.');
      declaration = await realpath(declarationFile);
      if (!(await stat(declaration)).isFile()) fail('Declaration must be a file.');
    }
    const existing = this.state.roots.find(root => root.path === resolved);
    if (existing) {
      if (declaration !== undefined && existing.declarationFile !== declaration) {
        if (existing.declarationFile) fail(`Project is already bound to declaration ${existing.declarationFile}. Use that file or a separate workspace state.`, 409);
        existing.declarationFile = declaration;
        await this.persist();
      }
      return existing;
    }
    const root = { id: randomUUID(), path: resolved, name: path.basename(resolved),
      ...(declaration === undefined ? {} : { declarationFile: declaration }) };
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

  listConversations(rootId) {
    const all = this.state.conversations;
    if (!all || typeof all !== 'object' || Array.isArray(all)) return [];
    return (all[rootId] ?? []).map(entry => ({ ...entry }));
  }

  async recordConversation(rootId, { conversation, agent, task } = {}) {
    const shaped = agent === 'kimi' ? KIMI_CONVERSATION_ID.test(conversation) : CONVERSATION_ID.test(conversation);
    if (typeof conversation !== 'string' || !shaped) fail('An agent conversation must be a UUID rEngine minted, or a session id in the shape the named CLI resumes by.');
    if (agent !== undefined && (typeof agent !== 'string' || agent.length > 256)) fail('Invalid agent name for a conversation.');
    // `task` is the one join between the task system and the agent system (spec 103 decision 6): a
    // conversation started from a task carries that task's key, so the Sessions tab and
    // workspace_info show which task an agent works and the Tasks pane shows which agents work a
    // task. Only ever set explicitly; an omitted task leaves whatever the record already carried.
    if (task !== undefined && task !== null && (typeof task !== 'string' || !task.length || task.length > 128)) fail('A conversation task is the key of one task row.');
    if (!this.state.roots.some(root => root.id === rootId)) fail('Unknown project root.', 404);
    if (!this.state.conversations || typeof this.state.conversations !== 'object' || Array.isArray(this.state.conversations)) this.state.conversations = {};
    const list = this.state.conversations[rootId] ?? [];
    const entry = list.find(item => item.id === conversation) ?? { id: conversation, startedAt: Date.now() };
    entry.lastSeenAt = Date.now();
    if (agent !== undefined) entry.agent = agent;
    if (task === null) delete entry.task; else if (task !== undefined) entry.task = task;
    this.state.conversations[rootId] = [entry, ...list.filter(item => item !== entry)].slice(0, CONVERSATION_LIMIT);
    await this.persist();
    return { ...entry };
  }

  async preferences(values) {
    if (!values || typeof values !== 'object') fail('Invalid preferences.');
    // The desktop's settings live here so a second window and a restarted desktop agree (spec 080).
    const { agent, vim, theme, syntax, explorer, accentHue, themes, recording } = values;
    if (agent !== undefined && (typeof agent !== 'string' || agent.length > 256)) fail('Invalid agent preference.');
    if (vim !== undefined && typeof vim !== 'boolean') fail('Invalid Vim preference.');
    for (const [key, value] of [['theme', theme], ['syntax', syntax], ['explorer', explorer]]) {
      if (value !== undefined && (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value))) fail(`Invalid ${key} preference.`);
    }
    if (accentHue !== undefined && (typeof accentHue !== 'number' || !Number.isFinite(accentHue) || accentHue < 0 || accentHue >= 360)) {
      fail('Invalid accent hue preference.');
    }
    if (recording !== undefined) {
      if (typeof recording !== 'object' || !recording || Array.isArray(recording)) fail('Invalid recording preference.');
      for (const [name, value] of Object.entries(recording)) {
        const range = RECORDING[name];
        if (!range) fail(`Invalid recording preference key ${name}.`);
        if (!Number.isInteger(value) || value < range[0] || value > range[1]) {
          fail(`Invalid recording preference ${name}; expected an integer between ${range[0]} and ${range[1]}.`);
        }
      }
    }
    // A project theme is remembered per root, so the entry survives reopening that project (spec 080).
    if (themes !== undefined) {
      if (typeof themes !== 'object' || !themes || Array.isArray(themes)) fail('Invalid project theme preference.');
      const entries = Object.entries(themes);
      if (entries.length > 64) fail('Too many project themes.');
      for (const [root, name] of entries) {
        if (typeof root !== 'string' || root.length > 64 || typeof name !== 'string' || name.length > 64) fail('Invalid project theme preference.');
      }
    }
    this.state.preferences = { ...this.state.preferences,
      ...(agent !== undefined ? { agent } : {}), ...(vim !== undefined ? { vim } : {}),
      ...(theme !== undefined ? { theme } : {}), ...(syntax !== undefined ? { syntax } : {}),
      ...(explorer !== undefined ? { explorer } : {}), ...(accentHue !== undefined ? { accentHue } : {}),
      ...(themes !== undefined ? { themes: { ...this.state.preferences.themes, ...themes } } : {}),
      ...(recording !== undefined ? { recording: { ...this.state.preferences.recording, ...recording } } : {}) };
    await this.persist();
    return this.state.preferences;
  }
}

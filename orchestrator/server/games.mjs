import { stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './store.mjs';
import { shellEnvironment } from './sessions.mjs';
import { readDeclaration } from './formats.mjs';
import { Surfaces } from './surfaces.mjs';

const nativeDirectory = fileURLToPath(new URL('../../.cache/native/', import.meta.url));
export const UNDECLARED = 'This project declares no game in .rengine/project.json (contract 2).';
async function executableAt(file) {
  try { await access(file, constants.X_OK); return (await stat(file)).isFile(); } catch { return false; }
}
export async function resolveCandidate(rootPath, candidate, environment = shellEnvironment()) {
  const suffixes = process.platform === 'win32' ? ['', '.exe'] : [''];
  if (path.isAbsolute(candidate) || /[\\/]/.test(candidate)) {
    const resolved = path.resolve(rootPath, candidate);
    for (const suffix of suffixes) if (await executableAt(`${resolved}${suffix}`)) return `${resolved}${suffix}`;
    return null;
  }
  const pathKey = Object.keys(environment).find(key => key.toUpperCase() === 'PATH');
  for (const directory of (environment[pathKey] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) { const file = path.join(directory, `${candidate}${suffix}`); if (await executableAt(file)) return file; }
  }
  return null;
}
export class Games {
  constructor(store, sessions, surfaces) { this.store = store; this.sessions = sessions; this.surfaces = surfaces; this.items = new Map(); this.launches = new Map(); }
  static async open(store, sessions) {
    const games = new Games(store, sessions, await new Surfaces().listen());
    sessions.on('event', event => {
      if (event.type === 'session' && event.session.state === 'exited') {
        const item = games.items.get(event.session.id);
        if (item) { games.surfaces.remove(item); games.items.delete(event.session.id); }
      }
    });
    return games;
  }
  async inspect(rootId) {
    const root = this.store.root(rootId);
    const declared = await readDeclaration(root.path);
    const unready = issue => ({ rootId, declared: false, args: [], cwd: root.path, issues: [issue], ready: false });
    if (!declared.declared) return unready(UNDECLARED);
    if (declared.error) return unready(declared.error);
    if (declared.gameError) return unready(declared.gameError);
    if (!declared.game) return unready(UNDECLARED);
    const { game } = declared, issues = [];
    let executable;
    for (const candidate of game.executable) { const found = await resolveCandidate(root.path, candidate); if (found) { executable = found; break; } }
    if (!executable) issues.push(`Game executable not found; expected ${game.executable.join(' or ')} in the selected project.`);
    for (const relative of game.requires ?? []) {
      try { if (!(await stat(path.join(root.path, relative))).isFile()) throw new Error(); }
      catch { issues.push(`Required file is missing: ${relative}.`); }
    }
    const config = { rootId, declared: true, id: game.id, title: game.title, surface: game.surface, executable, args: game.args ?? [], env: game.env ?? {}, requires: game.requires ?? [], cwd: root.path };
    if (game.surface === 'sdl2-interpose') {
      config.adapter = path.join(nativeDirectory, 'librengine_surface.dylib');
      if (process.platform === 'darwin') {
        try { await access(config.adapter); } catch { issues.push('Build the native surface first: npm run build:surface'); }
      } else issues.push('The cooperative SDL surface needs host integration and qualification on this platform.');
    }
    return { ...config, issues, ready: issues.length === 0 };
  }
  async launch(rootId) {
    if (this.launches.has(rootId)) return this.launches.get(rootId);
    const pending = this.start(rootId); this.launches.set(rootId, pending);
    try { return await pending; } finally { this.launches.delete(rootId); }
  }
  async start(rootId) {
    const existing = this.sessions.list().find(session => session.type === 'game' && session.rootId === rootId && session.state === 'running');
    if (existing) return existing;
    const config = await this.inspect(rootId);
    if (!config.ready) fail(config.issues.join('\n'), 409);
    const root = this.store.root(rootId);
    const base = { rootId, type: 'game', command: config.executable, args: config.args, title: `${config.title} · ${root.name}`, surface: config.surface, game: config.id };
    if (config.surface !== 'sdl2-interpose') return this.sessions.terminal({ ...base, env: config.env });
    const { item, env } = this.surfaces.reserve();
    try {
      const session = await this.sessions.terminal({ ...base, env: { ...config.env, ...env, DYLD_INSERT_LIBRARIES: [config.adapter, process.env.DYLD_INSERT_LIBRARIES].filter(Boolean).join(':') } });
      item.id = session.id; this.items.set(session.id, item);
      return session;
    } catch (error) { this.surfaces.remove(item); throw error; }
  }
  attach(id, socket) {
    const item = this.items.get(id);
    if (!item) { socket.close(1008, 'Game session is unavailable'); return; }
    this.surfaces.attach(item, socket);
  }
  async close() { await this.surfaces.close(); }
}

import { stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './store.mjs';
import { Surfaces } from './surfaces.mjs';

const nativeDirectory = fileURLToPath(new URL('../../.cache/native/', import.meta.url));
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
    const candidates = process.platform === 'win32' ? ['build/Release/relith-nolf.exe', 'build/relith-nolf.exe'] : ['build/relith-nolf'];
    let executable;
    for (const relative of candidates) {
      try { const file = await this.store.resolve(rootId, relative); await access(file.absolute, constants.X_OK); executable = file.absolute; break; }
      catch (error) { if (!['ENOENT', 'EACCES'].includes(error.code)) throw error; }
    }
    const issues = [];
    if (!executable) issues.push(`Build NOLF first; expected ${candidates.join(' or ')} in the selected project.`);
    try { if (!(await stat(path.join(root.path, 'nolf/NOLF.REZ'))).isFile()) throw new Error(); }
    catch { issues.push('NOLF data is missing: expected nolf/NOLF.REZ in the selected project.'); }
    const adapter = path.join(nativeDirectory, 'librengine_surface.dylib');
    if (process.platform === 'darwin') {
      try { await access(adapter); } catch { issues.push('Build the native surface first: npm run build:surface'); }
    } else issues.push('The cooperative SDL surface needs host integration and qualification on this platform.');
    return { rootId, executable, adapter, args: ['--flat', '--game', 'nolf', '--width', '1280', '--height', '720'], cwd: root.path, issues, ready: issues.length === 0 };
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
    const { item, env } = this.surfaces.reserve();
    try {
      const session = await this.sessions.terminal({ rootId, type: 'game', command: config.executable, args: config.args,
        env: { ...env, DYLD_INSERT_LIBRARIES: [config.adapter, process.env.DYLD_INSERT_LIBRARIES].filter(Boolean).join(':'),
          RELITH_HIDDEN_WINDOW: '1', RELITH_SKIP_INTRO: '1' } });
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

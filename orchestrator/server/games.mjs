import { fail } from './store-client.mjs';
import { askProject } from './project-client.mjs';
import { declarationOf, probeCacheFor } from './devices.mjs';
/* The surfaces that reserve a workspace pane. red-project holds the same set for the rule that
   refuses a pane game bound to another machine (`rules.rs`, sidecar: pane-surfaces); the two move
   together in F155, when this module follows the rules it shares them with. */
const PANE_SURFACES = ['embedded', 'cooperative'];
const streamsIntoPane = surface => PANE_SURFACES.includes(surface);
import { Surfaces } from './surfaces.mjs';

const PLACEHOLDER = /\$\{/;
const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
/* Literal argv a caller appends to the record's own, held to the record's own rules. */
function extraArguments(args) {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args) || args.length > 64) fail('Extra launch arguments must be a list of at most 64 literal arguments.');
  for (const value of args) {
    if (typeof value !== 'string' || !value.length || value.length > 4096 || PLACEHOLDER.test(value) || value.includes('\0')) {
      fail(`Extra launch argument ${JSON.stringify(value)} must be a literal argument without \${…}.`);
    }
  }
  return [...args];
}
/* The preflight is `red_project::games`'s (F155): what a declared game needs before it can be
   launched, including THE rule of spec 082 — a non-local target is never resolved or stat-ed
   against the local filesystem, because that check is what produced "Game executable not found"
   for a target that can never be built here. It shares the Devices tab's probe cache, so asking
   about a game on an unreachable box does not wait out that box's timeout a second time.

   Launching stays here, with the session host's process state. */
export async function inspectGame(root, gameId, options = {}) {
  return askProject(['game', root.id, root.path, gameId ?? '', probeCacheFor(root), declarationOf(root)]);
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
  async inspect(rootId, gameId) { return inspectGame(await this.store.root(rootId), gameId); }
  async launch(rootId, gameId, args) {
    const extra = extraArguments(args);
    const config = await this.inspect(rootId, gameId);
    const argv = [...(config.args ?? []), ...extra];
    const key = `${rootId}\0${config.id ?? ''}`; /* one launch per root AND declared game; see sidecar: launch-identity */
    const flight = this.launches.get(key);
    if (flight && same(flight.argv, argv)) return flight.promise; /* an identical concurrent launch joins the flight */
    const promise = (flight ? flight.promise.catch(() => {}) : Promise.resolve()).then(() => this.start(config, argv));
    this.launches.set(key, { argv, promise });
    try { return await promise; } finally { if (this.launches.get(key)?.promise === promise) this.launches.delete(key); }
  }
  async start(config, argv) {
    if (!config.declared) fail(config.issues.join('\n'), 409);
    if (config.refusal) fail(config.refusal, 409); /* a direct caller reaches the same refusal the worker issues first */
    const existing = this.sessions.list().find(session => session.type === 'game' && session.rootId === config.rootId && session.game === config.id && session.state === 'running');
    /* Refused, never silently attached with the caller's arguments dropped; see sidecar: launch-identity. */
    if (existing && !same(existing.args ?? [], argv)) {
      fail(`${config.title} is already running with different arguments (${(existing.args ?? []).join(' ')}); stop it in Sessions before launching it with ${argv.join(' ')}.`, 409);
    }
    if (existing) return existing;
    if (!config.ready) fail(config.issues.join('\n'), 409);
    const root = await this.store.root(config.rootId);
    const base = { rootId: config.rootId, type: 'game', command: config.executable, args: argv, cwd: config.cwd,
      title: `${config.title} · ${root.name}`, surface: config.surface, game: config.id };
    if (!streamsIntoPane(config.surface)) return this.sessions.terminal({ ...base, env: config.env });
    /* The one difference between the two pane surfaces, and it is deliberately a difference in the
       environment rather than a flag: a cooperative game connects itself, so injecting the adapter
       as well would put two producers on one token. See sidecar: cooperative-injection. */
    const injection = config.surface === 'embedded'
      ? { DYLD_INSERT_LIBRARIES: [config.adapter, process.env.DYLD_INSERT_LIBRARIES].filter(Boolean).join(':') } : {};
    const { item, env } = this.surfaces.reserve();
    try {
      const session = await this.sessions.terminal({ ...base, env: { ...config.env, ...env, ...injection } });
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

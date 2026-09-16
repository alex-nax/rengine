/* What a pane is CALLED and what a CLI is launched with — the two things a JavaScript caller still
 * asks this file (F152, spec 129).
 *
 * The Sessions class is gone with `server/main.mjs`: since charter D62 a pane's record belongs to
 * the state directory's PTY service, and `red-host` is the one host that reads it. Its own tests
 * went with it, and what they proved lives where the record does — `red-host.test.mjs` asks two
 * hosts on one directory what a pane is, and `pty-retention.test.mjs` asks what survives a host.
 *
 * What stayed is what has callers outside a host: the shell envelope a CLI is launched into, the
 * bash a launcher needs on Windows, and a pane's title. `red_agents` owns the composition itself
 * (F168); these are how JavaScript asks for the parts of it that are not a launch.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { processIdentity as agentsProcessIdentity, installPaths as agentsInstallPaths, shortAgentId } from '../agents/agents-client.mjs';
/* One conversation, one set of eight characters: the pane title, the picker row, the identity label
   and the token segment all show the same prefix, so a person recognises the same thing in each. */
export const agentTitle = (agent, conversation, rootName) =>
  `${agent || 'Choose agent'}${conversation ? ` ${shortAgentId(agent, conversation)}` : ''} · ${rootName}`;

/* What the declared CLIs stamp on every process they start, naming that one session: a host that
   carries them marks every pane it spawns a child of the session that started it (KI-113). The list
   is the RECIPES' — one CLI's variables used to be written out here, so the second CLI to stamp its
   own would have gone on marking every pane a child (F220, spec 141). `envelope()` reads it, which
   is why this is the async door and `shellEnvironment` takes what it found. */
export const agentProcessIdentity = () => agentsProcessIdentity();
export const agentInstallPaths = () => agentsInstallPaths();

/** The envelope with the declarations already fetched — what a caller in an async context uses. */
export async function envelope(overrides = {}, options = {}) {
  const [identity, installs] = await Promise.all([agentProcessIdentity(), agentInstallPaths()]);
  return shellEnvironment(overrides, { ...options, identity, installs });
}

export function shellEnvironment(overrides = {}, { inherited = process.env, platform = process.platform, userDirectory = homedir(), identity = [], installs = [] } = {}) {
  const win = platform === 'win32';
  const paths = win ? path.win32 : path.posix;
  const key = name => win ? name.toUpperCase() : name;
  const entries = new Map();
  for (const values of [inherited, overrides, { TERM: 'xterm-256color', COLORTERM: 'truecolor' }]) {
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string') entries.set(key(name), [name, value]);
      else entries.delete(key(name));
    }
  }
  entries.delete(key('ELECTRON_RUN_AS_NODE'));
  // TERM/COLORTERM above declare this surface colour-capable; an inherited NO_COLOR would
  // contradict that for every pane the host ever spawns. An explicit override still wins.
  // A pane is a fresh top-level session, nobody's child — see sidecar: a-pane-is-nobodys-child-session.
  const overridden = new Set(Object.keys(overrides).map(key));
  for (const name of ['NO_COLOR', ...identity]) if (!overridden.has(key(name))) entries.delete(key(name));
  const env = Object.fromEntries(entries.values());
  const pathKey = entries.get(key('PATH'))?.[0] ?? (win ? 'Path' : 'PATH');
  /* The places a CLI's own installer puts it, declared by the recipes, plus the two generic ones a
     person's tools land in. Order is preserved: declared first, as it always was. */
  const extra = ['.local/bin', '.n/bin', ...installs, '.cargo/bin'].map(part => paths.join(userDirectory, part));
  const candidates = [...(env[pathKey] === undefined ? [] : env[pathKey].split(paths.delimiter)), ...extra];
  const seen = new Set();
  env[pathKey] = candidates.filter(value => {
    const identity = win ? value.toLowerCase() : value;
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  }).join(paths.delimiter);
  return env;
}

/* One refusal, rather than a dependency on the store's client for it: this file has no other reason
   to know about a store. */
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function bashPath() {
  if (process.env.RENGINE_BASH) return process.env.RENGINE_BASH;
  if (process.platform !== 'win32') return '/bin/bash';
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git/bin/bash.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Git/bin/bash.exe'),
  ];
  const bash = candidates.find(existsSync);
  if (!bash) fail('Agent launcher requires Git Bash on Windows. Install Git for Windows or set RENGINE_BASH.');
  return bash;
}

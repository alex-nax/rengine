/* The thin client of the red-agents stdio service (F173, F149c, spec 129, KI-093): the surface
 * registry.mjs and config.mjs presented, while the recipes are parsed and the launch plans decided
 * in the Rust process this spawns — the shape store-client.mjs established for the store (F174).
 *
 * Two kinds of call, because the consumers have two kinds of caller:
 *
 *   - `recipe`, `agentNames` and the small derivations over them are SYNCHRONOUS, because
 *     `modelArgs` and `ideConnectFlag` are synchronous exports and F173 keeps external APIs
 *     unchanged. They read a projection primed once per process by running the dump binary, so JS
 *     never parses the registry document — Rust is still the only thing that does.
 *   - `agentLaunch` and `agentIdentity` go over the service, because they are already async and
 *     because they are decisions rather than lookups.
 *
 * The "cooked" view is assembled here from the projection: a compiled RegExp and a few closures
 * that are pure derivations of data the service sent. The one thing NOT carried over is `parse` —
 * choosing a conversation from a CLI's own flags is a decision, and it moved to the Rust side with
 * the rest of them.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKOUT = fileURLToPath(new URL('../', import.meta.url));
function binary(declared, name, crate) {
  const named = process.env[declared];
  if (named) {
    if (existsSync(named)) return named;
    throw new Error(`${declared} names ${named}, which does not exist.`);
  }
  for (const profile of ['debug', 'release']) {
    const candidate = path.join(CHECKOUT, 'red/target', profile, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`The ${name} binary is required (run: cargo build -p ${crate}, or set ${declared}).`);
}

export const MCP_OVERLAYS = ['flag', 'config-args', 'env-defaults', 'env-inline', 'project-file'];
export const HOOK_OVERLAYS = [null, 'per-launch-settings', 'per-launch-config', 'guided-bootstrap'];
export const REGISTRY_DOCUMENT = fileURLToPath(new URL('../orchestrator/agents/registry.toml', import.meta.url));

/* Primed once per process, and re-primed when the extra document's name changes: the module this
   replaces read RENGINE_AGENT_REGISTRY_EXTRA at call time so a recipe added as data needed no
   restart, and a snapshot that ignored it would quietly take that away. */
/* Kept per extra-document path rather than in one slot: the module this replaces cached the parsed
   result under that key and never read the file again, so a document that has since been removed
   goes on answering. A single slot re-read it whenever the key changed and changed back, which is
   a live test's temp directory being deleted underneath a prime. */
const primed = new Map();
function projection() {
  const extra = process.env.RENGINE_AGENT_REGISTRY_EXTRA ?? '';
  if (primed.has(extra)) return primed.get(extra);
  const registry = process.env.RENGINE_AGENT_REGISTRY || REGISTRY_DOCUMENT;
  /* The extra document is named on the dump's own command line rather than left to it to find:
     the binary takes it as an explicit argument, and passing inputs in is the same seam the launch
     plan uses. */
  const text = execFileSync(binary('RENGINE_RED_AGENTS_DUMP', 'red-agents-dump', 'red-agents'),
    [registry, ...(extra ? ['--extra', extra] : [])], { encoding: 'utf8' });
  const value = JSON.parse(text);
  primed.set(extra, value);
  return value;
}
/** Forget the primed projection: for a test that rewrites the document under a live process. */
export const forgetRecipes = () => primed.clear();

const cookConversation = talk => talk && ({
  start: talk.start ? id => [...talk.start.args, id] : null,
  resume: id => [...talk.resume.args, id],
  ids: new RegExp(talk.ids, 'i'),
  short: id => (talk.short?.stripPrefix ? id.replace(new RegExp(`^${talk.short.stripPrefix}`, 'i'), '') : id).slice(0, talk.short?.length ?? 8),
  normalize: talk.normalize === 'lowercase' ? id => id.toLowerCase() : id => id,
  provider: talk.provider,
  resumeLine: id => talk.resumeLine.replace('{id}', id),
});
const cook = raw => raw && ({
  ...raw,
  model: raw.model?.flag ? model => [raw.model.flag, model] : null,
  models: raw.models ?? { kind: 'none' },
  conversation: cookConversation(raw.conversation),
  hooks: raw.hooks ?? null,
  ide: raw.ide ? { flags: raw.ide.flags, env: port => ({ [raw.ide.envVar]: String(port) }) } : null,
});

export const agentNames = () => Object.keys(projection());
export const recipe = cli => cook(projection()[cli]);
export const resolvedRecipes = () => projection();
export const agentConversation = agent => recipe(agent)?.conversation ?? null;
export const agentCli = (agent, executable) => {
  if (projection()[agent]) return agent;
  const base = path.basename(executable ?? agent ?? '').replace(/\.(exe|cmd|bat)$/i, '');
  return base || 'agent';
};
export const shortAgentId = (agent, id) => (recipe(agent)?.conversation?.short ?? (value => value.slice(0, 8)))(id);
export const agentLabel = (agent, executable, agentId) =>
  agentId ? `${agentCli(agent, executable)} ${shortAgentId(agent, agentId)}` : agentCli(agent, executable);
export const shellQuote = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/* ---- the service, for the decisions ---------------------------------------------------------- */

let service = null;
function open() {
  if (service) return service;
  const child = spawn(binary('RENGINE_RED_AGENTS_SERVE', 'red-agents-serve', 'red-agents'), [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let sequence = 0, onStarted;
  const started = new Promise((resolve, reject) => {
    onStarted = resolve;
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      for (const entry of pending.values()) entry.reject(new Error(`red-agents-serve exited (${code ?? signal}).`));
      if (service?.child === child) service = null;
    });
  });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.started !== undefined) { onStarted?.(message); onStarted = null; return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
  });
  /* Loop-neutral: a client nobody closes must not hold the process open. A call in flight refs the
     pipes, so an answer is always heard. */

  const idle = [child, child.stdin, child.stdout];
  /* Loop-neutral at rest: a service nobody closed must not keep the host process alive. */
  started.finally(() => { for (const handle of idle) handle.unref(); }).catch(() => {});
  /* Refs are COUNTED, because ref/unref are not: with two calls in flight, the first answer's
     unref would release the handles the second is still waiting on, the loop would drain, and that
     call would never resolve. `Promise.all` of two reads did exactly that (KI-121); the sibling
     client in runtime/service-client.mjs had already met this and says so in the same words. */
  let flights = 0;
  const hold = () => { if (flights++ === 0) for (const handle of idle) handle.ref(); };
  const release = () => { if (--flights === 0) for (const handle of idle) handle.unref(); };
  service = {
    child,
    started,
    /* Every request names the documents it is about: the service must not answer from the
       environment it was spawned in. */
    call: (method, args = []) => started.then(() => {
      hold();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, args,
          registry: process.env.RENGINE_AGENT_REGISTRY || REGISTRY_DOCUMENT,
          extra: process.env.RENGINE_AGENT_REGISTRY_EXTRA ?? '' })}\n`);
      }).finally(release);
    }),
  };
  return service;
}
export const closeAgents = () => { service?.child.kill(); service = null; };

const NODE = process.execPath;
/* The path the FROZEN RECORD carries, which is a string rather than a file: `agents/mcp.mjs` is
   deleted, and a pane's server is `red-mcp --facade` now (spec 146). This fixture exists to drive
   `launch_plan` through the older `mcpMain` shape the record was taken through, so it keeps naming
   what the record names. What a real launch composes is asserted directly in
   red-agents-launch.test.mjs, and that assertion is what would catch this going stale. */
const MCP_MAIN = fileURLToPath(new URL('../orchestrator/agents/mcp.mjs', import.meta.url));
const redAgentsBinary = () => binary('RENGINE_RED_AGENTS', 'red-agents', 'red-agents');

export const describeSession = identity => open().call('describeSession', [identity ?? null]);
/* The pane-identity composition (F178): what the pane launches, what it claims to be, and what it
   is offered. The mint and the clock travel as data, so a pane's plan is a function of its inputs
   and a test never depends on a draw. */
export const paneComposition = ({ mint = randomUUID(), now = Date.now(), ...input }) =>
  open().call('paneComposition', [{ ...input, mint, now }]);
/* Which retained PTY this launch is running inside, when the workspace listed one: an input,
   because it is a fact about this process tree rather than a decision. The JS looked at its own pid
   and its parent's; on Windows it never looked at all. */
const ptySessionId = (sessions = []) => {
  if (process.platform === 'win32') return null;
  const owners = new Set([process.pid, process.ppid].filter(value => Number.isSafeInteger(value) && value > 1));
  return sessions.find(item => item?.type === 'agent' && owners.has(item.pid))?.id ?? null;
};
export const agentIdentity = ({ sessions = [], ...inputs } = {}) => open().call('agentIdentity', [{
  pid: process.pid, platform: process.platform, ptySessionId: ptySessionId(sessions), ...inputs,
}]);
/* What this CLI declares it can be handed: `{ kind, ready }` or null. The door asks this rather
   than comparing a name, so a CLI that declares the capability reaches the same path (F216). */
export const conversationHandoff = agent => open().call('conversationHandoff', [agent]);
/* Unions over every declared CLI, not facts about one: what each stamps on its children (a pane
   must inherit none of it, KI-113) and where each installs itself (F220, spec 141). */
export const processIdentity = () => open().call('processIdentity', []);
export const installPaths = () => open().call('installPaths', []);
/* Every CLI that declares it, for a caller with a manifest and no CLI named: one is the answer,
   several means the caller has to say which, none means nothing here can be handed one. */
export const handoffCapableAgents = async () => {
  const capable = [];
  for (const name of agentNames()) if (await conversationHandoff(name)) capable.push(name);
  return capable;
};
export const conversationArgs = (agent, identity, resume = false) =>
  open().call('conversationArgs', [agent, identity ?? null, resume]);
export const hookKey = (group = 0, handler = 0) => open().call('hookKey', [group, handler]);
export const hookTrustHash = (command, matcher = 'startup|resume') => open().call('hookTrustHash', [command, matcher]);

/* The environment-dependent inputs the service does not gather for itself (owner, 2026-09-13): the
   root context, the workspace's session list and the IDE probe's answer. */
export async function agentLaunch({ agent, executable, args = [], contextFile, context, directory, identity, handoff,
  conversation, resume = false, env = process.env, cwd = null, ourPids = [], ide, sessions = [] } = {}) {
  /* The IDE answer, resolved here because probing for a published editor is a filesystem and port
     scan (owner, 2026-09-13). A recipe that declares an editor flag always gets an answer — with no
     working directory the honest one is that auto-connect was not considered, which is what the CLI
     is told and why. */
  let resolvedIde = null;
  if (recipe(agent)?.ide) {
    const probe = ide ?? (await import('./ide-connect.mjs')).autoConnect;
    resolvedIde = typeof probe === 'function'
      ? (cwd ? await probe(agent, cwd, { ourPids }) : { flags: [], env: {}, reason: 'No working directory was given, so auto-connect was not considered.' })
      : probe ?? null;
  } else if (typeof ide === 'function') {
    resolvedIde = await ide(agent, cwd, { ourPids });
  } else if (ide) {
    resolvedIde = ide;
  }
  /* The root context is an input, so it is read here: the service decides with it and never goes
     looking for it. A caller that passed only the file gets the same launch either way. */
  const root = context ?? JSON.parse(await readFile(contextFile, 'utf8'));
  /* The workspace's session list, so the identity can say which retained PTY this launch runs in.
     An input, and a best-effort one exactly as it was: a launch is not refused because the host did
     not answer in time. */
  let listed = sessions;
  if (!listed.length) {
    try {
      const [{ request }, { checkConnection }] = await Promise.all([
        import('./sidecar.mjs'), import('./protocol.mjs')]);
      listed = (await request(checkConnection(root), 'state')).sessions ?? [];
    } catch { listed = []; }
  }
  return open().call('agentLaunch', [{
    agent, executable, args, contextFile, context: root, directory: directory ?? null,
    identity: identity ?? null, handoff: handoff ?? null, conversation: conversation ?? null, resume,
    env: { ...env }, cwd, sessions: listed, ide: resolvedIde, ptySessionId: ptySessionId(listed),
    platform: process.platform, pid: process.pid, nodeExecutable: NODE, mcpMain: MCP_MAIN, redAgents: redAgentsBinary(),
  }]);
}

/* ---- bind, which is a command rather than a lookup ------------------------------------------- */

/* Home is passed rather than left to the service to read: a caller may be probing a state tree
   other than its own, and the tests do exactly that. */
const stateHome = () => process.env.XDG_STATE_HOME || path.join(process.env.HOME ?? '', '.local/state');
export const stateDirectories = (explicit, home = stateHome()) =>
  open().call('stateDirectories', [explicit ?? null, home]);
export const bind = (argv, { home = stateHome() } = {}) => open().call('bind', [argv, home, {
  /* Nothing is spawned by bind, so the pid the identity records is the terminal that will run the
     CLI: the process that is actually alive while this agent works. */
  pid: Number.isSafeInteger(process.ppid) && process.ppid > 1 ? process.ppid : process.pid,
  platform: process.platform,
  nodeExecutable: NODE, mcpMain: MCP_MAIN, redAgents: redAgentsBinary(),
}]);

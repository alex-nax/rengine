import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { request } from '../launcher/sidecar.mjs';
import { autoConnect } from './ide-connect.mjs';
import { checkConnection } from '../runtime/protocol.mjs';
import { recipe } from './registry.mjs';

const mcpMain = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
const reportMain = fileURLToPath(new URL('./report-session.mjs', import.meta.url));

// Which CLIs accept being told the conversation they are starting, and how to resume that one.
// The two are separate capabilities the recipe declares: kimi can be put back into a conversation
// (--session) but has no spelling for being told which one to START, so its start is null and
// rEngine never mints one. An agent whose recipe declares no conversation names its own; rEngine
// records no identifier it cannot resume.
export const agentConversation = agent => recipe(agent)?.conversation ?? null;
const object = (text, name) => {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${name}; existing configuration was preserved.`);
  return value;
};
const add = (values, key, value) => {
  if (values !== undefined && (!values || typeof values !== 'object' || Array.isArray(values))) throw new Error('Existing MCP configuration is not an object.');
  if (Object.hasOwn(values ?? {}, key)) throw new Error(`Existing configuration already defines ${key}; refusing to replace it.`);
  return { ...values, [key]: value };
};
async function privateJson(filename, value) { await writeFile(filename, JSON.stringify(value, null, 2), { mode: 0o600 }); return filename; }

export function agentCli(agent, executable) {
  if (recipe(agent)) return agent;
  const base = path.basename(executable ?? agent ?? '').replace(/\.(exe|cmd|bat)$/i, '');
  return base || 'agent';
}
/* Two sessions of one CLI on one root are two identities, and the status bar has to tell them
   apart, so the label carries the first eight characters of the id the CLI resumes by — the
   recipe's short form, which skips the `session_` prefix every kimi id carries, a prefix that
   would otherwise be all the eight said. */
export const shortAgentId = (agent, id) => (recipe(agent)?.conversation?.short ?? (value => value.slice(0, 8)))(id);
export const agentLabel = (agent, executable, agentId) =>
  agentId ? `${agentCli(agent, executable)} ${shortAgentId(agent, agentId)}` : agentCli(agent, executable);

/* The identity IS the agent's session id, so the launcher can hand back the line that resumes it. */
function sessionOf(provider, id, source) {
  return { provider, id, known: source !== 'unknown', source, resume: recipe(provider).conversation.resumeLine(id) };
}
/* The conversation IS the identity, so exactly one identifier is ever named, and only when rEngine
   is the one naming it: a launch whose own flags carry a session is passed through untouched, and a
   launch that continues or forks is given nothing to claim an id the CLI keeps to itself. */
export function conversationArgs(agent, identity, resume = false) {
  const talk = agentConversation(agent);
  const session = identity?.session;
  if (!talk || !session || session.provider !== agent) return [];
  if (session.source === 'bound') return talk.resume(session.id);
  if (session.source === 'minted' || session.source === 'workspace') return resume ? talk.resume(session.id) : talk.start?.(session.id) ?? [];
  return [];
}
export function describeSession(identity) {
  const session = identity?.session;
  if (!session) return null;
  return session.known
    ? `${session.provider} session ${session.id}; resume this agent with: ${session.resume}`
    : `${session.provider} session id unknown: this launch continues or forks a conversation the CLI names itself, so the identity ${identity.agentId} is rEngine's own and no resume line is offered.`;
}
async function listedSessions(context) {
  try { return (await request(checkConnection(context), 'state')).sessions ?? []; } catch { return []; }
}
/* Where the id comes from, in the order that decides it, for any CLI whose recipe declares a
   conversation: the person's own flags win over the workspace's, because the pane reports back what
   actually launched and the record follows the launch; the workspace's minted conversation is the
   identity for every ordinary pane. A conversation the CLI cannot be told (no resume, no start
   spelling) is not this pane's to claim. */
function recipeIdentity(talk, { args, session, handoff, conversation, resume }) {
  const named = talk.parse(args);
  if (named.id || named.source === 'unknown') return named;
  const bound = session ?? handoff?.sessionId;
  if (bound) return { id: bound, source: 'bound' };
  if (conversation) {
    if (typeof conversation !== 'string' || !talk.ids.test(conversation))
      throw new Error(`An agent conversation must be a session id in a shape ${talk.provider} resumes by.`);
    return talk.start || resume ? { id: talk.normalize(conversation), source: 'workspace' } : { id: null, source: 'minted' };
  }
  return { id: null, source: 'minted' };
}
export async function agentIdentity({ agent, executable, args = [], handoff, session, conversation, resume = false, pid = process.pid, sessions = [] }) {
  const talk = agentConversation(agent);
  const ident = talk ? recipeIdentity(talk, { args, session, handoff, conversation, resume }) : null;
  const agentId = ident?.id ?? session ?? randomUUID();
  /* A launch that names nothing claims nothing: the CLI mints its own conversation, and a session
     object here would invent one rEngine cannot resume — unless the recipe has a start spelling
     (claude), because then the minted id is told to the CLI at launch. An opaque launch (a
     continue, a fork, a bare selector) still records that it does not know. */
  const identity = { agentId, label: agentLabel(agent, executable, agentId), pid, startedAt: new Date().toISOString(),
    ...(ident?.id ? { session: sessionOf(agent, ident.id, ident.source) }
      : ident?.source === 'unknown' ? { session: sessionOf(agent, agentId, 'unknown') }
      : talk?.start ? { session: sessionOf(agent, agentId, 'minted') } : {}) };
  if (process.platform === 'win32') return identity;
  const owners = new Set([process.pid, process.ppid].filter(value => Number.isSafeInteger(value) && value > 1));
  const pty = sessions.find(item => item?.type === 'agent' && owners.has(item.pid));
  return pty ? { ...identity, sessionId: pty.id } : identity;
}
export const shellQuote = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
/* The launcher decides the conversation at launch and then goes blind: a /resume performed inside
   the running CLI changes which conversation the process is in, and no flag, transcript or process
   tree says so afterwards. So the CLI is asked to say it. Claude Code's SessionStart hook fires on
   startup, --resume, an in-CLI /resume, /clear and after compaction, carrying the session_id it is
   actually running, and report-session.mjs reports that back. The settings live beside this launch's
   MCP configuration; the person's own and the project's settings files are never touched.
   The hook is given this launch's context file on its own command line, so a session started by hand
   from the line bind.mjs prints -- which inherits none of the launcher's environment -- reports
   itself too. Claude Code runs the command through a shell, and that shell is cmd on Windows, where
   POSIX single quotes are literal characters rather than quoting. */
const hookQuote = value => process.platform === 'win32'
  ? (/^[A-Za-z0-9_@%+=:,.\\/-]+$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`) : shellQuote(value);
export const claudeSettings = contextFile => ({ hooks: { SessionStart: [{ hooks: [{ type: 'command',
  command: [process.execPath, reportMain, '--context', contextFile].map(hookQuote).join(' ') }] }] } });
export const claudeSettingsFile = (directory, contextFile) => privateJson(path.join(directory, 'settings.json'), claudeSettings(contextFile));

/* Codex runs only hooks it trusts: a non-managed hook needs a hooks.state."<key>".trusted_hash
   entry naming the sha256 of its normalized identity (codex-rs hooks/src/engine/discovery.rs
   hook_hash over config/src/fingerprint.rs version_for_toml). The key for a hook injected through
   -c is codex's synthetic session-flags layer path plus the event and the handler's position, and
   the identity is the hook's own definition with the defaults codex fills (timeout 600, async
   false, unset fields omitted). The launcher trusts exactly the command it composed, in the same
   -c layer that carries it, so the person's own hooks keep their review gate and nothing is
   written to ~/.codex — verified live against codex 0.153.4 (docs/evidence/codex-sessionstart-hook-2026-09-11.md). */
export const codexHookKey = (group = 0, handler = 0) =>
  `${process.platform === 'win32' ? 'C:\\<session-flags>\\config.toml' : '/<session-flags>/config.toml'}:session_start:${group}:${handler}`;
export function codexHookTrustHash(command, matcher = 'startup|resume') {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const identity = { event_name: 'session_start', matcher, hooks: [{ type: 'command', command, timeout: 600, async: false }] };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(identity)), 'utf8').digest('hex')}`;
}
export function describeInvocation(plan) {
  return [...Object.entries(plan.consumes.env).map(([key, value]) => `${key}=${shellQuote(value)}`),
    shellQuote(plan.executable), ...plan.consumes.args.map(shellQuote)].join(' ');
}

/* Where kimi looks for project-level MCP servers: .kimi-code/mcp.json at the repository root — the
   only per-project channel the CLI publishes (there is no flag and no environment override). The
   file is the project's, so every entry outside rEngine's rengine_ namespace is preserved verbatim
   and an unreadable file is refused rather than rewritten; the namespace itself is reclaimed whole,
   because a stale key in it points at a per-launch context that no longer exists. */
async function kimiMcpFile(directory, name, server) {
  let root = path.resolve(directory);
  for (;;) {
    if (existsSync(path.join(root, '.git'))) break;
    const parent = path.dirname(root);
    if (parent === root) { root = path.resolve(directory); break; }
    root = parent;
  }
  const file = path.join(root, '.kimi-code', 'mcp.json');
  let previous = {};
  try { previous = object(await readFile(file, 'utf8'), 'Kimi MCP configuration'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous.mcpServers !== undefined && (!previous.mcpServers || typeof previous.mcpServers !== 'object' || Array.isArray(previous.mcpServers)))
    throw new Error('Existing Kimi MCP configuration is not an object; it was preserved.');
  const kept = Object.fromEntries(Object.entries(previous.mcpServers ?? {}).filter(([key]) => !key.startsWith('rengine_')));
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await privateJson(file, { ...previous, mcpServers: { ...kept, [name]: { command: server.command, args: server.args } } });
  return file;
}

export async function agentLaunch({ agent, executable, args = [], contextFile, context, directory, identity, handoff, conversation, resume = false, env = process.env, cwd = null, ourPids = [], ide = autoConnect }) {
  const root = context ?? JSON.parse(await readFile(contextFile, 'utf8'));
  if (!/^[0-9a-f-]{36}$/.test(root.rootId)) throw new Error('Invalid project identity in workspace context.');
  const name = `rengine_${root.rootId.replaceAll('-', '').slice(0, 12)}`;
  const home = path.join(directory ?? path.dirname(contextFile), `${name}-${randomUUID()}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const bound = identity ?? await agentIdentity({ agent, executable, args, handoff, conversation, resume, sessions: await listedSessions(root) });
  const boundFile = await privateJson(path.join(home, 'context.json'), { ...root, agent: bound });
  const server = { type: 'stdio', command: process.execPath, args: [mcpMain, '--context', boundFile] };
  const generic = await privateJson(path.join(home, 'mcp.json'), { mcpServers: { [name]: server } });
  const consumes = { args: [], env: {} };
  const plan = { executable, name, generic, consumes, identity: bound, contextFile: boundFile, directory: home };
  const declared = recipe(agent);
  const overlay = declared?.mcp?.kind;
  if (overlay === 'config-args') {
    consumes.args = ['-c', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`,
      '-c', `mcp_servers.${name}.args=${JSON.stringify(server.args)}`, '-c', `mcp_servers.${name}.required=true`];
    /* The SessionStart hook rides the same -c channel as the MCP wiring: codex loads hooks from
       every config layer, so the person's own ~/.codex entries run beside this launch's, untouched.
       The reporter is given this launch's context on its own command line and told its provider,
       exactly like claude's settings-file hook, and the feature is enabled for this launch only.
       Codex runs a non-managed hook only when its exact definition is trusted, so the same layer
       carries this launch's trusted_hash — the launcher trusts what it composed, nothing else, and
       nothing is written to ~/.codex. */
    if (declared.hooks?.kind === 'per-launch-config') {
      const command = [process.execPath, reportMain, '--provider', agent, '--context', boundFile].map(hookQuote).join(' ');
      consumes.args.push('-c', 'features.hooks=true',
        '-c', `hooks.SessionStart=[{matcher="startup|resume",hooks=[{type="command",command=${JSON.stringify(command)}}]}]`,
        '-c', `hooks.state={${JSON.stringify(codexHookKey())}={trusted_hash=${JSON.stringify(codexHookTrustHash(command))}}}`);
    }
    consumes.args.push(...conversationArgs(agent, bound, resume));
  } else if (overlay === 'flag') {
    /* Told to report what it runs, and to connect to the editor it runs inside, only when the
       recipe says the CLI accepts either — and for the editor only when exactly one is published
       for this directory, the CLI's own rule: a menu nobody opened is worse than typing /ide. */
    if (declared.hooks?.kind === 'per-launch-settings') plan.settings = await claudeSettingsFile(home, boundFile);
    if (declared.ide) {
      plan.ide = cwd ? await ide(agent, cwd, { ourPids })
        : { flags: [], env: {}, reason: 'No working directory was given, so auto-connect was not considered.' };
    }
    consumes.args = ['--mcp-config', generic,
      ...(plan.settings ? ['--settings', plan.settings] : []),
      ...(plan.ide?.flags ?? []), ...conversationArgs(agent, bound, resume)];
  } else if (overlay === 'env-inline') {
    const envVar = declared.mcp.envVar;
    const previous = env[envVar] ? object(env[envVar], `${envVar} runtime configuration`) : {};
    consumes.env[envVar] = JSON.stringify({ ...previous,
      mcp: add(previous.mcp, name, { type: 'local', command: [server.command, ...server.args], enabled: true }) });
  } else if (overlay === 'env-defaults') {
    const defaults = env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ?? (process.platform === 'darwin' ? '/Library/Application Support/GeminiCli/system-defaults.json'
      : process.platform === 'win32' ? path.join(env.ProgramData ?? 'C:\\ProgramData', 'gemini-cli/system-defaults.json') : '/etc/gemini-cli/system-defaults.json');
    let previous = {};
    try { previous = object(await readFile(defaults, 'utf8'), 'Gemini system defaults'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    consumes.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = await privateJson(path.join(home, 'gemini-defaults.json'), {
      ...previous, mcpServers: add(previous.mcpServers, name, { command: server.command, args: server.args }),
    });
  } else if (overlay === 'project-file') {
    plan.kimi = await kimiMcpFile(cwd ?? process.cwd(), name, server);
    consumes.args = conversationArgs(agent, bound, resume);
  } else plan.custom = true;
  /* What the host's record should say this pane holds. `null` is the honest answer for a launch
     that continues or forks: the identity is rEngine's own and no record may claim it names the
     conversation. An agent whose recipe declares no conversation is recorded with nothing at all. */
  if (agentConversation(agent)) plan.conversation = bound.session?.known ? bound.agentId : null;
  plan.args = [...consumes.args, ...args];
  plan.env = { ...env, RENGINE_MCP_CONFIG: generic, ...consumes.env, ...(plan.ide?.env ?? {}) };
  return plan;
}

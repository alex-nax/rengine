import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { request } from '../launcher/sidecar.mjs';
import { autoConnect } from './ide-connect.mjs';
import { checkConnection } from '../runtime/protocol.mjs';

const mcpMain = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
const reportMain = fileURLToPath(new URL('./report-session.mjs', import.meta.url));
const NAMED = ['claude', 'codex', 'gemini', 'opencode', 'kimi'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
/* The shapes kimi resumes by, observed (`session_<uuid>`) and documented (a ULID); the `session_`
   prefix is part of the id the CLI reports on its SessionStart hook. */
const KIMI_SESSION = /^(?:session_)?(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i;
// Which CLIs accept being told the conversation they are starting, and how to resume that one.
// The two are separate capabilities: kimi can be put back into a conversation (--session) but has
// no spelling for being told which one to START, so its start is null and rEngine never mints one.
// An agent absent from this table names its own; rEngine records no identifier it cannot resume.
const CONVERSATIONS = {
  claude: { start: id => ['--session-id', id], resume: id => ['--resume', id] },
  kimi: { start: null, resume: id => ['--session', id] },
};
export const agentConversation = agent => CONVERSATIONS[agent] ?? null;
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
  if (NAMED.includes(agent)) return agent;
  const base = path.basename(executable ?? agent ?? '').replace(/\.(exe|cmd|bat)$/i, '');
  return base || 'agent';
}
/* Two sessions of one CLI on one root are two identities, and the status bar has to tell them
   apart, so the label carries the first eight characters of the id the CLI resumes by — skipping
   the `session_` prefix every kimi id carries, which would otherwise be all the eight said. */
export const shortAgentId = (agent, id) => (agent === 'kimi' ? id.replace(/^session_/i, '') : id).slice(0, 8);
export const agentLabel = (agent, executable, agentId) =>
  agentId ? `${agentCli(agent, executable)} ${shortAgentId(agent, agentId)}` : agentCli(agent, executable);

/* What the CLI's own flags say about which conversation this launch will be. `--session-id`/`--resume`
   name it; `--continue` and a fork mint one inside the CLI, where rEngine cannot see it. */
export function claudeSession(args = []) {
  let named = null, opaque = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    if (flag === '--fork-session' || flag === '-c' || flag === '--continue') opaque = true;
    else if (['--session-id', '--resume', '-r'].includes(flag)) {
      const value = inline ?? args[index + 1];
      if (inline === null) index++;
      if (UUID.test(value ?? '')) named = value.toLowerCase(); else opaque = true;
    }
  }
  if (named && !opaque) return { id: named, source: 'flag' };
  return { id: null, source: opaque ? 'unknown' : 'minted' };
}
/* kimi's spellings for the conversation it resumes: --session/-S and the hidden -r/--resume
   aliases name it; a bare --session opens the CLI's own selector and -c/--continue takes the most
   recent — each a conversation only the CLI knows. There is no start-with-id spelling at all. */
export function kimiSession(args = []) {
  let named = null, opaque = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    if (flag === '-c' || flag === '--continue') opaque = true;
    else if (['--session', '-S', '--resume', '-r'].includes(flag)) {
      const value = inline ?? args[index + 1];
      if (inline === null) index++;
      if (KIMI_SESSION.test(value ?? '')) named = value; else opaque = true;
    }
  }
  if (named && !opaque) return { id: named, source: 'flag' };
  return { id: null, source: opaque ? 'unknown' : 'minted' };
}
/* The identity IS the agent's session id, so the launcher can hand back the line that resumes it. */
const RESUME_LINE = { claude: id => `claude --resume ${id}`, codex: id => `codex resume ${id}`, kimi: id => `kimi --session ${id}` };
function sessionOf(provider, id, source) {
  return { provider, id, known: source !== 'unknown', source, resume: RESUME_LINE[provider](id) };
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
/* Where the id comes from, in the order that decides it. The person's own flags win over the
   workspace's, because the pane reports back what actually launched and the record follows the
   launch; the workspace's minted conversation is the identity for every ordinary pane. */
function claudeIdentity({ args, session, conversation, resume }) {
  const named = claudeSession(args);
  if (named.id || named.source === 'unknown') return named;
  if (session) return { id: session, source: 'bound' };
  if (conversation) {
    if (typeof conversation !== 'string' || !UUID.test(conversation)) throw new Error('An agent conversation must be a UUID rEngine minted.');
    return { id: conversation.toLowerCase(), source: 'workspace' };
  }
  return { id: null, source: 'minted' };
}
/* Where kimi's id comes from, in the same order as claude's: the person's own flags, the workspace's
   recorded conversation being resumed — and then nothing. A conversation that cannot be told to the
   CLI (no resume, no start spelling) is not this pane's to claim. */
function kimiIdentity({ args, session, conversation, resume }) {
  const named = kimiSession(args);
  if (named.id || named.source === 'unknown') return named;
  if (session) return { id: session, source: 'bound' };
  if (conversation) {
    if (typeof conversation !== 'string' || !KIMI_SESSION.test(conversation)) throw new Error('An agent conversation must be a session id in a shape kimi resumes by.');
    return resume ? { id: conversation, source: 'workspace' } : { id: null, source: 'minted' };
  }
  return { id: null, source: 'minted' };
}
export async function agentIdentity({ agent, executable, args = [], handoff, session, conversation, resume = false, pid = process.pid, sessions = [] }) {
  const claude = agent === 'claude' ? claudeIdentity({ args, session, conversation, resume }) : null;
  const codex = agent === 'codex' ? (session ?? handoff?.sessionId ?? null) : null;
  const kimi = agent === 'kimi' ? kimiIdentity({ args, session, conversation, resume }) : null;
  const agentId = claude?.id ?? codex ?? kimi?.id ?? session ?? randomUUID();
  const identity = { agentId, label: agentLabel(agent, executable, agentId), pid, startedAt: new Date().toISOString(),
    ...(claude ? { session: sessionOf('claude', agentId, claude.source) } : {}),
    ...(codex ? { session: sessionOf('codex', agentId, 'flag') } : {}),
    /* A kimi launch that names nothing claims nothing: the CLI mints its own conversation, and a
       session object here would invent one rEngine cannot resume. An opaque launch (its -c, or a
       bare --session selector) still records that it does not know. */
    ...(kimi?.id ? { session: sessionOf('kimi', kimi.id, kimi.source) } : kimi?.source === 'unknown' ? { session: sessionOf('kimi', agentId, 'unknown') } : {}) };
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
  if (agent === 'codex') {
    consumes.args = ['-c', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`,
      '-c', `mcp_servers.${name}.args=${JSON.stringify(server.args)}`, '-c', `mcp_servers.${name}.required=true`];
  } else if (agent === 'claude') {
    plan.settings = await claudeSettingsFile(home, boundFile);
    /* Told to connect to the editor it runs inside, but only when exactly one is published for this
       directory — the CLI's own rule, and a menu nobody opened is worse than typing /ide. */
    const connect = cwd ? await ide(agent, cwd, { ourPids }) : { flags: [], env: {}, reason: 'No working directory was given, so auto-connect was not considered.' };
    plan.ide = connect;
    consumes.args = ['--mcp-config', generic, '--settings', plan.settings,
      ...connect.flags, ...conversationArgs(agent, bound, resume)];
  } else if (agent === 'opencode') {
    const previous = env.OPENCODE_CONFIG_CONTENT ? object(env.OPENCODE_CONFIG_CONTENT, 'OpenCode runtime configuration') : {};
    consumes.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...previous,
      mcp: add(previous.mcp, name, { type: 'local', command: [server.command, ...server.args], enabled: true }) });
  } else if (agent === 'gemini') {
    const defaults = env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ?? (process.platform === 'darwin' ? '/Library/Application Support/GeminiCli/system-defaults.json'
      : process.platform === 'win32' ? path.join(env.ProgramData ?? 'C:\\ProgramData', 'gemini-cli/system-defaults.json') : '/etc/gemini-cli/system-defaults.json');
    let previous = {};
    try { previous = object(await readFile(defaults, 'utf8'), 'Gemini system defaults'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    consumes.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = await privateJson(path.join(home, 'gemini-defaults.json'), {
      ...previous, mcpServers: add(previous.mcpServers, name, { command: server.command, args: server.args }),
    });
  } else if (agent === 'kimi') {
    plan.kimi = await kimiMcpFile(cwd ?? process.cwd(), name, server);
    consumes.args = conversationArgs(agent, bound, resume);
  } else plan.custom = true;
  /* What the host's record should say this pane holds. `null` is the honest answer for a launch
     that continues or forks: the identity is rEngine's own and no record may claim it names the
     conversation. An agent absent from the table is recorded with nothing at all. */
  if (agentConversation(agent)) plan.conversation = bound.session?.known ? bound.agentId : null;
  plan.args = [...consumes.args, ...args];
  plan.env = { ...env, RENGINE_MCP_CONFIG: generic, ...consumes.env, ...(plan.ide?.env ?? {}) };
  return plan;
}

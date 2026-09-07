import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { request } from '../launcher/sidecar.mjs';
import { checkConnection } from '../runtime/protocol.mjs';

const mcpMain = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
const NAMED = ['claude', 'codex', 'gemini', 'opencode'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
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
/* Two Claude sessions on one root are two identities, and the status bar has to tell them apart, so
   the label carries the first eight characters of the id the CLI itself resumes by. */
export const agentLabel = (agent, executable, agentId) =>
  agentId ? `${agentCli(agent, executable)} ${agentId.slice(0, 8)}` : agentCli(agent, executable);

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
/* The identity IS the agent's session id, so the launcher can hand back the line that resumes it. */
function sessionOf(provider, id, source) {
  const resume = provider === 'codex' ? `codex resume ${id}` : `claude --resume ${id}`;
  return { provider, id, known: source !== 'unknown', source, resume };
}
/* Only a minted id has to be told to the CLI; one the caller's own flags named is already the
   conversation it will be, and a bound identity names a session that exists and is resumed. */
const claudeStart = identity => identity?.session?.provider !== 'claude' ? []
  : identity.session.source === 'minted' ? ['--session-id', identity.session.id]
  : identity.session.source === 'bound' ? ['--resume', identity.session.id] : [];
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
export async function agentIdentity({ agent, executable, args = [], handoff, session, pid = process.pid, sessions = [] }) {
  const claude = agent === 'claude' ? (session ? { id: session, source: 'bound' } : claudeSession(args)) : null;
  const codex = agent === 'codex' ? (session ?? handoff?.sessionId ?? null) : null;
  const agentId = claude?.id ?? codex ?? session ?? randomUUID();
  const identity = { agentId, label: agentLabel(agent, executable, agentId), pid, startedAt: new Date().toISOString(),
    ...(claude ? { session: sessionOf('claude', agentId, claude.source) } : {}),
    ...(codex ? { session: sessionOf('codex', agentId, 'flag') } : {}) };
  if (process.platform === 'win32') return identity;
  const owners = new Set([process.pid, process.ppid].filter(value => Number.isSafeInteger(value) && value > 1));
  const pty = sessions.find(item => item?.type === 'agent' && owners.has(item.pid));
  return pty ? { ...identity, sessionId: pty.id } : identity;
}
export const shellQuote = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
export function describeInvocation(plan) {
  return [...Object.entries(plan.consumes.env).map(([key, value]) => `${key}=${shellQuote(value)}`),
    shellQuote(plan.executable), ...plan.consumes.args.map(shellQuote)].join(' ');
}

export async function agentLaunch({ agent, executable, args = [], contextFile, context, directory, identity, handoff, env = process.env }) {
  const root = context ?? JSON.parse(await readFile(contextFile, 'utf8'));
  if (!/^[0-9a-f-]{36}$/.test(root.rootId)) throw new Error('Invalid project identity in workspace context.');
  const name = `rengine_${root.rootId.replaceAll('-', '').slice(0, 12)}`;
  const home = path.join(directory ?? path.dirname(contextFile), `${name}-${randomUUID()}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const bound = identity ?? await agentIdentity({ agent, executable, args, handoff, sessions: await listedSessions(root) });
  const boundFile = await privateJson(path.join(home, 'context.json'), { ...root, agent: bound });
  const server = { type: 'stdio', command: process.execPath, args: [mcpMain, '--context', boundFile] };
  const generic = await privateJson(path.join(home, 'mcp.json'), { mcpServers: { [name]: server } });
  const consumes = { args: [], env: {} };
  const plan = { executable, name, generic, consumes, identity: bound, contextFile: boundFile, directory: home };
  if (agent === 'codex') {
    consumes.args = ['-c', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`,
      '-c', `mcp_servers.${name}.args=${JSON.stringify(server.args)}`, '-c', `mcp_servers.${name}.required=true`];
  } else if (agent === 'claude') consumes.args = ['--mcp-config', generic, ...claudeStart(bound)];
  else if (agent === 'opencode') {
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
  } else plan.custom = true;
  plan.args = [...consumes.args, ...args];
  plan.env = { ...env, RENGINE_MCP_CONFIG: generic, ...consumes.env };
  return plan;
}

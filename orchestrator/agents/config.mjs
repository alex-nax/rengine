import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { request } from '../launcher/sidecar.mjs';
import { checkConnection } from '../runtime/protocol.mjs';

const mcpMain = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
const NAMED = ['claude', 'codex', 'gemini', 'opencode'];
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

export function agentLabel(agent, executable) {
  if (NAMED.includes(agent)) return agent;
  const base = path.basename(executable ?? agent ?? '').replace(/\.(exe|cmd|bat)$/i, '');
  return base || 'agent';
}
async function listedSessions(context) {
  try { return (await request(checkConnection(context), 'state')).sessions ?? []; } catch { return []; }
}
export async function agentIdentity({ agent, executable, pid = process.pid, sessions = [] }) {
  const identity = { agentId: randomUUID(), label: agentLabel(agent, executable), pid, startedAt: new Date().toISOString() };
  if (process.platform === 'win32') return identity;
  const owners = new Set([process.pid, process.ppid].filter(value => Number.isSafeInteger(value) && value > 1));
  const session = sessions.find(item => item?.type === 'agent' && owners.has(item.pid));
  return session ? { ...identity, sessionId: session.id } : identity;
}
export const shellQuote = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
export function describeInvocation(plan) {
  return [...Object.entries(plan.consumes.env).map(([key, value]) => `${key}=${shellQuote(value)}`),
    shellQuote(plan.executable), ...plan.consumes.args.map(shellQuote)].join(' ');
}

export async function agentLaunch({ agent, executable, args = [], contextFile, context, directory, identity, env = process.env }) {
  const root = context ?? JSON.parse(await readFile(contextFile, 'utf8'));
  if (!/^[0-9a-f-]{36}$/.test(root.rootId)) throw new Error('Invalid project identity in workspace context.');
  const name = `rengine_${root.rootId.replaceAll('-', '').slice(0, 12)}`;
  const home = path.join(directory ?? path.dirname(contextFile), `${name}-${randomUUID()}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const bound = identity ?? await agentIdentity({ agent, executable, sessions: await listedSessions(root) });
  const boundFile = await privateJson(path.join(home, 'context.json'), { ...root, agent: bound });
  const server = { type: 'stdio', command: process.execPath, args: [mcpMain, '--context', boundFile] };
  const generic = await privateJson(path.join(home, 'mcp.json'), { mcpServers: { [name]: server } });
  const consumes = { args: [], env: {} };
  const plan = { executable, name, generic, consumes, identity: bound, contextFile: boundFile, directory: home };
  if (agent === 'codex') {
    consumes.args = ['-c', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`,
      '-c', `mcp_servers.${name}.args=${JSON.stringify(server.args)}`, '-c', `mcp_servers.${name}.required=true`];
  } else if (agent === 'claude') consumes.args = ['--mcp-config', generic];
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

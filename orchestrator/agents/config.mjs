import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse } from 'jsonc-parser';

const mcpMain = fileURLToPath(new URL('./mcp.mjs', import.meta.url));
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

export async function agentLaunch({ agent, executable, args = [], contextFile, env = process.env }) {
  const context = JSON.parse(await readFile(contextFile, 'utf8'));
  if (!/^[0-9a-f-]{36}$/.test(context.rootId)) throw new Error('Invalid project identity in workspace context.');
  const name = `rengine_${context.rootId.replaceAll('-', '').slice(0, 12)}`;
  const directory = path.join(path.dirname(contextFile), `${name}-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const server = { type: 'stdio', command: process.execPath, args: [mcpMain, '--context', contextFile] };
  const generic = await privateJson(path.join(directory, 'mcp.json'), { mcpServers: { [name]: server } });
  const plan = { executable, args: [...args], env: { ...env, RENGINE_MCP_CONFIG: generic }, name, generic };
  if (agent === 'codex') {
    plan.args = ['-c', `mcp_servers.${name}.command=${JSON.stringify(server.command)}`,
      '-c', `mcp_servers.${name}.args=${JSON.stringify(server.args)}`, '-c', `mcp_servers.${name}.required=true`, ...args];
  } else if (agent === 'claude') plan.args = ['--mcp-config', generic, ...args];
  else if (agent === 'opencode') {
    const previous = env.OPENCODE_CONFIG_CONTENT ? object(env.OPENCODE_CONFIG_CONTENT, 'OpenCode runtime configuration') : {};
    plan.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...previous,
      mcp: add(previous.mcp, name, { type: 'local', command: [server.command, ...server.args], enabled: true }) });
  } else if (agent === 'gemini') {
    const defaults = env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ?? (process.platform === 'darwin' ? '/Library/Application Support/GeminiCli/system-defaults.json'
      : process.platform === 'win32' ? path.join(env.ProgramData ?? 'C:\\ProgramData', 'gemini-cli/system-defaults.json') : '/etc/gemini-cli/system-defaults.json');
    let previous = {};
    try { previous = object(await readFile(defaults, 'utf8'), 'Gemini system defaults'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    plan.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = await privateJson(path.join(directory, 'gemini-defaults.json'), {
      ...previous, mcpServers: add(previous.mcpServers, name, { command: server.command, args: server.args }),
    });
  } else plan.custom = true;
  return plan;
}

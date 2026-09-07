import { mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { discoverSidecar, request } from '../launcher/sidecar.mjs';
import { agentIdentity, agentLaunch, describeInvocation, shellQuote } from './config.mjs';

const USAGE = `node orchestrator/agents/bind.mjs --project DIR [--agent claude|codex|gemini|opencode|EXECUTABLE] [--state DIR]
Binds an agent this workspace never spawned: finds the live instance that already serves DIR,
mints this launch its own identity, and writes the MCP configuration to start the agent with.
Without --state it scans the sidecar descriptors under \${XDG_STATE_HOME:-$HOME/.local/state}/rengine.
No RENGINE_* environment variable is read; the workspace is found by discovery.`;

const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (['--project', '--agent', '--state'].includes(flag)) {
    if (!process.argv[index + 1]) throw new Error(`Missing value for ${flag}`);
    options[flag.slice(2)] = process.argv[++index];
  } else if (flag === '--help' || flag === '-h') { console.log(USAGE); process.exit(0); }
  else throw new Error(`Unknown option: ${flag}\n${USAGE}`);
}
if (!options.project) throw new Error(`--project DIR is required.\n${USAGE}`);

const resolve = async value => { try { return await realpath(value); } catch { return path.resolve(value); } };

/* A consumer's editor.sh puts the state directory at ~/.local/state/rengine/<name>-<cksum>, a
   Windows install puts it in the checkout, and this development tree's own default IS the base
   directory. So the base and its children are both candidates. */
export async function stateDirectories(explicit, home = process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state')) {
  if (explicit) return [path.resolve(explicit)];
  const base = path.join(home, 'rengine');
  const found = [base];
  let entries = [];
  try { entries = await readdir(base, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of entries) if (entry.isDirectory()) found.push(path.join(base, entry.name));
  return found;
}

export async function findInstance(project, { state, home } = {}) {
  const scanned = await stateDirectories(state, home);
  const target = await resolve(path.resolve(project));
  const claims = [], problems = [];
  for (const directory of scanned) {
    let instance;
    try { instance = await discoverSidecar(directory); }
    catch (error) { problems.push(`${directory}: ${error.message}`); continue; }
    if (!instance) continue;
    let roots;
    try { roots = (await request(instance, 'state')).roots ?? []; }
    catch (error) { problems.push(`${directory}: ${error.message}`); continue; }
    for (const root of roots) if (await resolve(root.path) === target) claims.push({ directory, instance, root });
  }
  if (claims.length > 1) {
    throw new Error(`Two workspace instances claim ${target}:\n${claims.map(claim =>
      `  ${claim.directory}/sidecar.json — instance ${claim.instance.instance} at ${claim.instance.url}, root ${claim.root.id}`).join('\n')
      }\nClose one, or name the one you mean with --state DIR.`);
  }
  if (!claims.length) {
    throw new Error(`No live workspace instance serves ${target}. Scanned:\n${scanned.map(directory => `  ${directory}`).join('\n')}${
      problems.length ? `\nUnavailable:\n${problems.map(problem => `  ${problem}`).join('\n')}` : ''
      }\nOpen the project in rEngine first (its editor.sh), or name its state directory with --state DIR.`);
  }
  return { ...claims[0], scanned };
}

const { directory, instance, root } = await findInstance(options.project, { state: options.state });
const context = { url: instance.url, token: instance.token, instance: instance.instance, rootId: root.id };
const bindings = path.join(directory, 'bindings');
await mkdir(bindings, { recursive: true, mode: 0o700 });
/* Nothing is spawned here, so the launcher pid the identity records is the terminal that will run
   the CLI: the process that is actually alive while this agent works. */
const owner = Number.isSafeInteger(process.ppid) && process.ppid > 1 ? process.ppid : process.pid;
const identity = await agentIdentity({ agent: options.agent, executable: options.agent ?? 'custom', pid: owner });
const plan = await agentLaunch({ agent: options.agent, executable: options.agent ?? 'custom', context, directory: bindings, identity });

console.log(`Bound to ${root.name} (${root.path})`);
console.log(`  instance ${instance.instance} at ${instance.url}, discovered through ${path.join(directory, 'sidecar.json')}`);
console.log(`  identity ${identity.label} ${identity.agentId} (pid ${identity.pid})`);
console.log(`  context  ${plan.contextFile}`);
console.log(`  MCP configuration ${plan.generic}`);
if (plan.custom) {
  /* claude and codex consume this configuration as it stands; gemini and opencode need an overlay
     written for them, so bind writes that only for the CLI the caller names. */
  const server = JSON.parse(await readFile(plan.generic, 'utf8')).mcpServers[plan.name];
  console.log(`Start the agent from ${root.path} with the flag its CLI consumes:`);
  console.log(`  claude --mcp-config ${shellQuote(plan.generic)}`);
  console.log(`  codex ${['-c', `mcp_servers.${plan.name}.command=${JSON.stringify(server.command)}`,
    '-c', `mcp_servers.${plan.name}.args=${JSON.stringify(server.args)}`,
    '-c', `mcp_servers.${plan.name}.required=true`].map(shellQuote).join(' ')}`);
  console.log('  gemini, opencode: re-run with --agent gemini or --agent opencode, which writes the overlay those CLIs read.');
} else {
  console.log(`Start the agent from ${root.path} with:`);
  console.log(`  ${describeInvocation(plan)}`);
}

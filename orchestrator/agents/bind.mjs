import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSidecar, request } from '../launcher/sidecar.mjs';
import { agentIdentity, agentLaunch, claudeSettingsFile, describeInvocation, describeSession, shellQuote } from './config.mjs';

const USAGE = `node orchestrator/agents/bind.mjs --project DIR [--agent claude|codex|gemini|opencode|kimi|EXECUTABLE]
                                   [--session UUID] [--state DIR]
Binds an agent this workspace never spawned: finds the live instance that already serves DIR,
gives this agent an identity, and writes the MCP configuration to start the agent with.
The identity IS the agent's own session id: pass --session with the id the CLI resumes by
(Claude prints it on exit as \`claude --resume <id>\`) to bind the session that already exists,
or omit it to have one minted and started with --session-id.
Without --state it scans the sidecar descriptors under \${XDG_STATE_HOME:-$HOME/.local/state}/rengine.
No RENGINE_* environment variable is read; the workspace is found by discovery.`;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const resolve = async value => { try { return await realpath(value); } catch { return path.resolve(value); } };

/* A consumer's editor.sh puts the state directory at ~/.local/state/rengine/<name>-<cksum>, a
   Windows install puts it inside the checkout, and this development tree's own default IS the base
   directory. So the base and each of its children are candidates.

   Which directory a launcher chose is the launcher's business, though, and one named anything but
   `rengine` used to be invisible here even with its sidecar descriptor in plain sight -- an owner's
   own launcher naming its own (.../state/redit/<project>) could open a project that could then
   never be bound. So beyond the base, the DESCRIPTOR is what identifies a state directory, at the
   two depths a launcher plausibly uses. Directories without one are never opened. */
const directories = async (parent, strict = false) => {
  try { return (await readdir(parent, { withFileTypes: true })).filter(entry => entry.isDirectory())
    .map(entry => path.join(parent, entry.name)); }
  catch (error) { if (strict && error.code !== 'ENOENT') throw error; return []; }
};
const describesInstance = async directory => {
  try { await stat(path.join(directory, 'sidecar.json')); return true; } catch { return false; }
};
export async function stateDirectories(explicit, home = process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state')) {
  if (explicit) return [path.resolve(explicit)];
  const base = path.join(home, 'rengine');
  const found = [base, ...(await directories(base, true))];
  const seen = new Set(found);
  for (const directory of await directories(home)) {
    if (seen.has(directory)) continue;
    for (const candidate of (await describesInstance(directory)) ? [directory] : await directories(directory))
      if (!seen.has(candidate) && await describesInstance(candidate)) { seen.add(candidate); found.push(candidate); }
  }
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
      `  ${path.join(claim.directory, 'sidecar.json')} — instance ${claim.instance.instance} at ${claim.instance.url}, root ${claim.root.id}`).join('\n')
      }\nClose one, or name the one you mean with --state DIR.`);
  }
  if (!claims.length) {
    throw new Error(`No live workspace instance serves ${target}. Scanned:\n${scanned.map(directory => `  ${directory}`).join('\n')}${
      problems.length ? `\nUnavailable:\n${problems.map(problem => `  ${problem}`).join('\n')}` : ''
      }\nOpen the project in rEngine first (its editor.sh), or name its state directory with --state DIR.`);
  }
  return { ...claims[0], scanned };
}

export async function bind(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (['--project', '--agent', '--state', '--session'].includes(flag)) {
      if (!argv[index + 1]) throw new Error(`Missing value for ${flag}`);
      options[flag.slice(2)] = argv[++index];
    } else if (flag === '--help' || flag === '-h') return { usage: USAGE };
    else throw new Error(`Unknown option: ${flag}\n${USAGE}`);
  }
  if (!options.project) throw new Error(`--project DIR is required.\n${USAGE}`);
  if (options.session && !UUID.test(options.session)) throw new Error(`--session takes the agent session's UUID, not ${options.session}.`);
  const session = options.session?.toLowerCase();
  const { directory, instance, root } = await findInstance(options.project, { state: options.state });
  const context = { url: instance.url, token: instance.token, instance: instance.instance, rootId: root.id };
  const bindings = path.join(directory, 'bindings');
  await mkdir(bindings, { recursive: true, mode: 0o700 });
  /* Nothing is spawned here, so the pid the identity records is the terminal that will run the CLI:
     the process that is actually alive while this agent works. */
  const owner = Number.isSafeInteger(process.ppid) && process.ppid > 1 ? process.ppid : process.pid;
  const identity = await agentIdentity({ agent: options.agent, executable: options.agent ?? 'custom', pid: owner, session });
  /* kimi reads its MCP servers from the project's own .kimi-code/mcp.json, so the wiring goes to
     the bound root, not to whichever directory this command happens to run from. */
  const plan = await agentLaunch({ agent: options.agent, executable: options.agent ?? 'custom', context, directory: bindings, identity,
    ...(options.agent === 'kimi' ? { cwd: root.path } : {}) });
  const described = describeSession(identity);
  const lines = [`Bound to ${root.name} (${root.path})`,
    `  instance ${instance.instance} at ${instance.url}, discovered through ${path.join(directory, 'sidecar.json')}`,
    `  identity ${identity.label} — ${identity.agentId} (pid ${identity.pid})`,
    ...(described ? [`  ${described}`] : []),
    `  context  ${plan.contextFile}`,
    `  MCP configuration ${plan.generic}`,
    ...(plan.kimi ? [`  project MCP ${plan.kimi} (rEngine owns only the ${plan.name} entry)`] : [])];
  if (plan.custom) {
    /* claude and codex consume this configuration as it stands; gemini and opencode need an overlay
       written for them, so bind writes that only for the CLI the caller names. */
    const server = JSON.parse(await readFile(plan.generic, 'utf8')).mcpServers[plan.name];
    /* The identity is the Claude session id, so the claude line names it: --resume for a session
       that already exists, --session-id for the one this binding minted. It also carries --settings,
       so a session started outside the workspace reports its own conversation back the way a pane
       does: the identity here is only the launch's guess until the CLI confirms or corrects it. */
    const settings = await claudeSettingsFile(plan.directory, plan.contextFile);
    lines.push(`Start the agent from ${root.path} with the flag its CLI consumes:`,
      `  claude --mcp-config ${shellQuote(plan.generic)} --settings ${shellQuote(settings)} ${session ? '--resume' : '--session-id'} ${identity.agentId}`,
      `  codex ${['-c', `mcp_servers.${plan.name}.command=${JSON.stringify(server.command)}`,
        '-c', `mcp_servers.${plan.name}.args=${JSON.stringify(server.args)}`,
        '-c', `mcp_servers.${plan.name}.required=true`].map(shellQuote).join(' ')}`,
      '  gemini, opencode: re-run with --agent gemini or --agent opencode, which writes the overlay those CLIs read.',
      '  kimi: re-run with --agent kimi, which writes the project .kimi-code/mcp.json the CLI reads.');
  } else lines.push(`Start the agent from ${root.path} with:`, `  ${describeInvocation(plan)}`);
  return { instance, root, identity, plan, report: lines.join('\n') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  /* A refusal is something a person reads and acts on, so it prints as text and exits, never as a
     stack trace over the sentence naming what to do. */
  try { const result = await bind(process.argv.slice(2)); console.log(result.usage ?? result.report); }
  catch (error) { console.error(error.message); process.exit(2); }
}

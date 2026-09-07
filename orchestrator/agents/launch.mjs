import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { agentLaunch, describeSession } from './config.mjs';
import { request } from '../launcher/sidecar.mjs';
import { checkConnection } from '../runtime/protocol.mjs';
import { readHandoff, waitForPresentation, resumeArgs, checkResume } from './handoff.mjs';

const [agent, executable, contextFile, ...args] = process.argv.slice(2);
if (!agent || !executable || !contextFile) throw new Error('Expected agent identity, executable and workspace context.');
let handoff = null;
if (process.env.RENGINE_HANDOFF_GATE) {
  await waitForPresentation(process.env.RENGINE_HANDOFF_GATE);
  handoff = await readHandoff(process.env.RENGINE_HANDOFF_FILE, process.cwd());
  await checkResume(process.env.RENGINE_BASH, handoff.project, process.env);
  args.push(...resumeArgs(handoff));
}
/* This runs in the pane, so its own working directory is the one the CLI will inherit and the one
   the editor's lock has to cover. Read from disk at every pane launch, which is why auto-connect
   reaches a running workspace without replacing its session host. */
const plan = await agentLaunch({ agent, executable, contextFile, args, handoff, cwd: process.cwd(),
  conversation: process.env.RENGINE_AGENT_CONVERSATION, resume: process.env.RENGINE_AGENT_RESUME === '1' });
if (plan.ide) console.log(`Editor: ${plan.ide.reason}`);
// The identity decided here is the single source: the workspace may have minted a conversation, the
// person at the pane may have chosen another from the offered list, and their own --resume beats
// both. Report the id the CLI was actually started with, so the record follows the launch — and
// report null for a launch that continues or forks, so no record claims an id rEngine cannot resume.
if (plan.conversation !== undefined && process.env.RENGINE_ORCHESTRATOR_SESSION) {
  try {
    await request(checkConnection(JSON.parse(await readFile(contextFile, 'utf8'))), 'agent-conversation',
      { id: process.env.RENGINE_ORCHESTRATOR_SESSION, conversation: plan.conversation, agent });
  } catch (error) { console.error(`The workspace was not told which conversation this pane holds: ${error.message}`); }
}
if (plan.custom) console.log(`Custom agent MCP configuration: ${plan.generic} (also RENGINE_MCP_CONFIG). Configure this CLI to consume it.`);
else console.log(`Workspace MCP: ${plan.name}`);
const session = describeSession(plan.identity);
console.log(`Workspace identity: ${plan.identity.label}${session ? ` — ${session}` : ''}`);
if (process.platform === 'win32' && !process.env.RENGINE_BASH) throw new Error('Windows workspace bootstrap requires RENGINE_BASH.');
const command = process.platform === 'win32' ? process.env.RENGINE_BASH : plan.executable;
const argv = process.platform === 'win32' ? ['--noprofile', '--norc', '-c', 'exec "$@"', 'rengine-agent', plan.executable, ...plan.args] : plan.args;
const child = spawn(command, argv, { stdio: 'inherit', env: plan.env });
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });

import { spawn } from 'node:child_process';
import { agentLaunch } from './config.mjs';
import { readHandoff, waitForPresentation, resumeArgs, checkResume } from './handoff.mjs';

const [agent, executable, contextFile, ...args] = process.argv.slice(2);
if (!agent || !executable || !contextFile) throw new Error('Expected agent identity, executable and workspace context.');
if (process.env.RENGINE_HANDOFF_GATE) {
  await waitForPresentation(process.env.RENGINE_HANDOFF_GATE);
  const handoff = await readHandoff(process.env.RENGINE_HANDOFF_FILE, process.cwd());
  await checkResume(process.env.RENGINE_BASH, handoff.project, process.env);
  args.push(...resumeArgs(handoff));
}
const plan = await agentLaunch({ agent, executable, contextFile, args });
if (plan.custom) console.log(`Custom agent MCP configuration: ${plan.generic} (also RENGINE_MCP_CONFIG). Configure this CLI to consume it.`);
else console.log(`Workspace MCP: ${plan.name}`);
if (process.platform === 'win32' && !process.env.RENGINE_BASH) throw new Error('Windows workspace bootstrap requires RENGINE_BASH.');
const command = process.platform === 'win32' ? process.env.RENGINE_BASH : plan.executable;
const argv = process.platform === 'win32' ? ['--noprofile', '--norc', '-c', 'exec "$@"', 'rengine-agent', plan.executable, ...plan.args] : plan.args;
const child = spawn(command, argv, { stdio: 'inherit', env: plan.env });
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });

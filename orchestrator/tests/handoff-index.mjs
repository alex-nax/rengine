import { readFile, realpath, access, stat } from 'node:fs/promises';
import * as codex from './handoff-codex.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const agentScript = fileURLToPath(new URL('../../scripts/agent.sh', import.meta.url));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/* The declared kinds this module can read a conversation store for, and who reads each. One arm per
   adapter: a CLI whose store is a new shape is a new file and one line here (F220, spec 141). */
async function confirmConversation(kind, sessionId, root, env) {
  if (kind === 'rollout-jsonl') return codex.confirm(sessionId, root, env);
  throw new Error(`rEngine cannot read a ${kind} conversation store, so this handoff was not launched.`);
}

export async function readHandoff(filename, project, env = process.env, kind = 'rollout-jsonl') {
  filename = await realpath(filename);
  const source = await readFile(filename, 'utf8');
  if (source.length > 16384) throw new Error('Handoff manifest is too large.');
  const value = JSON.parse(source);
  if (value.version !== 1 || !uuid.test(value.sessionId) || typeof value.project !== 'string' || typeof value.checkpoint !== 'string') {
    throw new Error('Expected a version-1 handoff with project, sessionId UUID and checkpoint.');
  }
  const root = await realpath(path.resolve(path.dirname(filename), value.project));
  if (project && await realpath(project) !== root) throw new Error('Handoff belongs to a different project.');
  const checkpoint = await realpath(path.resolve(root, value.checkpoint));
  const relative = path.relative(root, checkpoint);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Checkpoint must be inside the project.');
  if (!(await stat(checkpoint)).isFile()) throw new Error('Checkpoint must be a file.');
  /* The conversation has to exist ON THIS MACHINE, which only the CLI's own adapter can say. The
     kind its recipe declares picks the reader; this half names no CLI (F220, spec 141). */
  await confirmConversation(kind, value.sessionId, root, env);
  return { filename, project: root, checkpoint, sessionId: value.sessionId };
}

/* Which CLI is asked is the caller's, from the pane being launched: agent.sh reads what that CLI
   declares "ready to resume" means (F216, spec 141). */
export async function checkResume(bash, cli, project, env) {
  try {
    await execute(bash, [agentScript, '--project', project, '--agent', cli, '--action', 'check-resume'],
      { env, timeout: 15000, maxBuffer: 65536 });
  } catch (error) { throw new Error(`${cli} resume prerequisites failed: ${error.stderr || error.message}`); }
}

export async function waitForPresentation(gate) {
  console.log('Handoff paused: waiting for the agent pane to be presented in rEngine.');
  while (true) {
    try { await access(gate); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(100);
  }
}

export function resumeArgs(handoff) {
  return ['resume', handoff.sessionId, '--cd', handoff.project,
    `The user authorized resuming development in this rEngine orchestrator pane. Read AGENTS.md and ${JSON.stringify(handoff.checkpoint)} before acting. Verify the root-bound rEngine MCP connection and RENGINE_ORCHESTRATOR_SESSION environment, then continue the paused goal from that checkpoint. Preserve all remaining constraints and outstanding approval boundaries. Do not start a duplicate goal or another copy of this conversation. This continuation was delivered once after native presentation; desktop reloads retain this CLI.`];
}

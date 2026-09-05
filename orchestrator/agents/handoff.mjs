import { readFile, realpath, readdir, open, access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const agentScript = fileURLToPath(new URL('../../scripts/agent.sh', import.meta.url));
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

async function findRollout(directory, sessionId, depth = 0) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) return filename;
    if (entry.isDirectory() && depth < 3) {
      const found = await findRollout(filename, sessionId, depth + 1);
      if (found) return found;
    }
  }
}

export async function readHandoff(filename, project, env = process.env) {
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
  const home = env.CODEX_HOME ?? path.join(homedir(), '.codex');
  const rollout = await findRollout(path.join(home, 'sessions'), value.sessionId)
    ?? await findRollout(path.join(home, 'archived_sessions'), value.sessionId);
  if (!rollout) throw new Error(`Cannot find local Codex conversation ${value.sessionId}. No substitute session was launched.`);
  const file = await open(rollout, 'r');
  let meta;
  try {
    const buffer = Buffer.alloc(65536); const { bytesRead } = await file.read(buffer);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw new Error('Codex session metadata is missing or too large.');
    meta = JSON.parse(buffer.subarray(0, end).toString('utf8'));
  } finally { await file.close(); }
  if (meta.type !== 'session_meta' || meta.payload?.id !== value.sessionId) throw new Error('Codex conversation metadata does not match the handoff.');
  if (await realpath(meta.payload.cwd) !== root) throw new Error('Codex conversation belongs to a different project.');
  return { filename, project: root, checkpoint, sessionId: value.sessionId };
}

export async function checkResume(bash, project, env) {
  try {
    await execute(bash, [agentScript, '--project', project, '--agent', 'codex', '--action', 'check-resume'],
      { env, timeout: 15000, maxBuffer: 65536 });
  } catch (error) { throw new Error(`Codex resume prerequisites failed: ${error.stderr || error.message}`); }
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

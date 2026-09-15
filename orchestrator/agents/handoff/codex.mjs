/* codex's half of a handoff: where it keeps a conversation, and how to tell that one is really
 * there. The JavaScript mirror of `red/red-host/src/handoff/codex.rs`, retiring with the rest of
 * the JS host under D57 — while it is live, it is an adapter and lives in a file named for its CLI,
 * which is what lets the manifest half name no CLI at all (F220, spec 141).
 *
 * The question it answers is narrow and the reason is in `index.mjs`: a handoff whose conversation
 * is not on this machine would quietly start a NEW one wearing the paused one's name.
 */
import { readdir, realpath, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** Codex names a rollout `<something>-<sessionId>.jsonl`, three directories deep at most. */
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

/** Is this conversation on this machine, and is it this project's? Throws when either fails. */
export async function confirm(sessionId, root, env) {
  const home = env.CODEX_HOME ?? path.join(homedir(), '.codex');
  const rollout = await findRollout(path.join(home, 'sessions'), sessionId)
    ?? await findRollout(path.join(home, 'archived_sessions'), sessionId);
  if (!rollout) throw new Error(`Cannot find local Codex conversation ${sessionId}. No substitute session was launched.`);
  const file = await open(rollout, 'r');
  let meta;
  try {
    const buffer = Buffer.alloc(65536); const { bytesRead } = await file.read(buffer);
    const end = buffer.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw new Error('Codex session metadata is missing or too large.');
    meta = JSON.parse(buffer.subarray(0, end).toString('utf8'));
  } finally { await file.close(); }
  if (meta.type !== 'session_meta' || meta.payload?.id !== sessionId) throw new Error('Codex conversation metadata does not match the handoff.');
  if (await realpath(meta.payload.cwd) !== root) throw new Error('Codex conversation belongs to a different project.');
}

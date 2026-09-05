import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readHandoff } from '../agents/handoff.mjs';

test('handoff binds an explicit local conversation and checkpoint to the real project', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sessionId = '00000000-0000-0000-0000-000000000058';
  const home = path.join(dir, 'codex');
  const sessions = path.join(home, 'sessions/2026/09/05');
  await mkdir(sessions, { recursive: true });
  await writeFile(path.join(dir, 'checkpoint.md'), 'Paused goal checkpoint.');
  const manifest = path.join(dir, 'handoff.json');
  await writeFile(manifest, JSON.stringify({ version: 1, project: '.', sessionId, checkpoint: 'checkpoint.md' }));
  const rollout = path.join(sessions, `rollout-test-${sessionId}.jsonl`);
  await assert.rejects(readHandoff(manifest, dir, { CODEX_HOME: home }), /Cannot find/);
  await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: home } }) + '\n');
  await assert.rejects(readHandoff(manifest, dir, { CODEX_HOME: home }), /different project/);
  await writeFile(rollout, JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: dir } }) + '\n');
  const result = await readHandoff(manifest, dir, { CODEX_HOME: home });
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.project, await (await import('node:fs/promises')).realpath(dir));
  await assert.rejects(readHandoff(manifest, home, { CODEX_HOME: home }), /different project/);
  await rm(path.join(dir, 'checkpoint.md'));
  await assert.rejects(readHandoff(manifest, dir, { CODEX_HOME: home }), /ENOENT/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

test('installed Codex boots through the Bash launcher in the native terminal', { timeout: 30000 }, async () => {
  assert.ok(process.env.RENGINE_NATIVE_AGENT_ROOT, 'Select an existing trusted project with RENGINE_NATIVE_AGENT_ROOT.');
  const directory = await mkdtemp(path.resolve('.cache/native-agent-'));
  let server, gui;
  try {
    server = await startServer({ stateDir: directory });
    const root = await server.store.addRoot(path.resolve(process.env.RENGINE_NATIVE_AGENT_ROOT));
    const agent = await server.sessions.terminal({ rootId: root.id, type: 'agent', agent: 'codex', action: 'launch' });
    gui = await nativeClient(server, { root: root.id, agent: agent.id });
    const state = await gui.until(s => s.tabs.some(t => t?.session === agent.id && /OpenAI Codex/.test(t.text ?? '')), 'installed Codex native terminal');
    assert.equal(state.state.sessions.find(s => s.id === agent.id).pid, agent.pid);
    await mkdir('.cache/evidence', { recursive: true });
    assert.equal(await gui.command({ op: 'snapshot', path: path.resolve('.cache/evidence/native-codex.bmp') }), true);
    await gui.close(); gui = null;
    assert.equal(server.sessions.snapshot(agent.id).state, 'running');
    await server.sessions.stop(agent.id);
  } finally { await gui?.close(); await server?.close(); }
});

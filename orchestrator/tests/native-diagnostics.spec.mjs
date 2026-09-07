import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { startWorker } from '../runtime/worker.mjs';
import { nativeClient } from './native-client.mjs';

/* The desktop is pointed at a workspace *worker*, not at a bare session host: the language servers
   and the diagnostics route live there, and a host on its own advertises no `ide` capability, which
   is what stops the desktop asking (KI-067). */
const FIXTURE = 'int main(void) {\n  // TODO unfinished\n  return 0;\n}\n';

test('the editor pane draws what the project\'s language server said', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-native-diagnostics-'));
  process.env.RENGINE_IDE_DIRECTORY ??= path.join(dir, 'locks');
  const project = path.join(dir, 'project');
  await mkdir(path.join(project, '.rengine'), { recursive: true });
  await writeFile(path.join(project, 'a.c'), FIXTURE);
  await writeFile(path.join(project, '.rengine', 'project.json'), JSON.stringify({
    contract: 7, project: 'diagnostics-fixture',
    formats: [{ id: 'c', title: 'C', match: ['*.c'], modes: ['text'], default: 'text' }],
    languageServers: [{ id: 'fake', languageId: 'c', match: ['*.c'],
      command: [process.execPath, path.resolve('orchestrator/tests/fake-language-server.mjs')] }],
  }));
  const host = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await host.store.addRoot(project);
  const worker = await startWorker({ url: host.url, token: host.token, instance: host.instance },
    { directory: path.join(dir, 'runtime'), ideOptions: { directory: path.join(dir, 'locks'), hostPid: process.pid } });
  const gui = await nativeClient(worker, { root: root.id });
  try {
    let state = await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the workspace');
    assert.equal(state.state.capabilities.ide, 1, 'the worker says it serves the IDE routes');

    await gui.control('tree-entry', 'a.c', 0);
    state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.path === 'a.c'), 'the file opens');
    const tab = state.tabs.findIndex(t => t?.type === 2 && t.path === 'a.c');
    const [x, y, w, h] = state.tabs[tab].rect;
    await gui.click(x + w / 2, y + h / 2);

    // The pane asks, the server answers, and the pane says how many it is drawing.
    state = await gui.until(s => s.tabs[tab]?.diagnostics === 1, 'the pane draws the server\'s diagnostic');
    assert.equal(state.tabs[tab].diagnostics, 1);

    // And it *stays* drawn. The pane asks twice a second and is answered `unchanged`; a version that
    // took that answer as an empty list would flicker between one and none, and a poll-until
    // assertion would still pass by catching the moment it was one. Sampling proves it holds.
    for (let i = 0; i < 6; i++) {
      const sample = await gui.command({ op: 'state' });
      assert.equal(sample.tabs[tab].diagnostics, 1, `it stays drawn between polls (sample ${i})`);
      await delay(200);
    }

    // Type into the buffer: the servers are told the unsaved text, so the count follows the edit
    // rather than the file on disk.
    await gui.command({ op: 'text', text: '// TODO another\n' });
    state = await gui.until(s => s.tabs[tab]?.diagnostics === 2, 'an unsaved edit changes what is drawn');
    assert.equal(state.tabs[tab].diagnostics, 2, 'the second TODO is reported without saving');
    assert.ok(state.tabs[tab].dirty, 'and the file is still unsaved');

    // "To agent" is a labelled control rather than a chord, and it is drawn because this workspace
    // serves the IDE routes. A pane bound to a bare host does not show it — there is nothing to say
    // it to — which is asserted in native-ide-selection.
    const mention = state.controls.find(c => c.role === 'mention' && c.tab === tab);
    assert.ok(mention, `the pane offers to send the file to an agent: ${JSON.stringify(state.controls.map(c => c.role))}`);
    await gui.control('mention', '', tab);
    state = await gui.until(s => /Sent to the agent/.test(s.status ?? ''), 'the desktop says it sent');
    assert.match(state.status, /Sent to the agent/);
  } finally {
    await gui.close(); await worker.close(); await host.close(); await rm(dir, { recursive: true, force: true });
  }
});

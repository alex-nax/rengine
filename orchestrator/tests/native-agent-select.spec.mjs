/* F192 (spec 134 D7): the toolbar's Agent control is a SELECT, not a text box.
 *
 * `design/previews/workspace/toolbar.html` has specified `re-button re-select agent` since spec
 * 064; the native drifted to `re_ui_textbox_ex`, so a person could type a CLI this machine has not
 * got and find out when the pane failed. The list is the workspace's own — the same `agents-menu`
 * the Tasks tab reads, asked for the SELECTED root — and an agent the registry knows but this
 * machine lacks is listed and refused rather than hidden, because a name a person can see is
 * missing is worth more than an absence they have to guess at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
import { startTasksSidecar } from './tasks-controls-fixtures.mjs';

const MENU = {
  agents: [
    { cli: 'claude', installed: true, models: ['opus'], default: 'opus' },
    { cli: 'codex', installed: true, models: ['gpt-6-astra'], default: 'gpt-6-astra' },
    { cli: 'gemini', installed: false, models: ['flash'], default: 'flash' },
  ],
  live: [],
};
const TRACKER = { rootId: '', declared: true, provider: 'local', rows: [] };
const listed = state => state.controls.filter(c => c.role === 'dropdown').map(c => c.key);

test('the toolbar agent control is a select, offering what this machine has', { timeout: 90000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-agent-select-'));
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const sidecar = await startTasksSidecar(server, { tracker: TRACKER, menu: MENU });
  const root = await server.store.addRoot(dir);
  const gui = await nativeClient({ ...server, url: sidecar.url }, { root: root.id });
  t.after(async () => { await gui.close(); await sidecar.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await gui.until(s => s.connected, 'the desktop connects through the worker stand-in');

  /* The control reports itself as a select. A text box would report role `textbox`, which is what
     this spec exists to stop coming back. */
  const start = await gui.until(s => s.controls.some(c => c.role === 'select' && c.key === 'agent'),
    'the toolbar carries an agent select');
  assert.ok(!start.controls.some(c => c.role === 'textbox' && c.key === 'agent'),
    'and no agent text box beside it');
  assert.deepEqual(listed(start), [], 'no list is open to begin with');

  await gui.control('select', 'agent', -1);
  const open = await gui.until(s => listed(s).length > 0, 'the agent list opened');
  assert.deepEqual(listed(open).sort(), ['claude', 'codex', 'gemini'],
    'every agent the menu names is listed, installed or not');

  /* Picking an installed one takes, closes the list, and is remembered as a preference. */
  await gui.control('dropdown', 'claude', -1);
  await gui.until(s => listed(s).length === 0, 'picking a value closes the list');
  await gui.until(s => s.controls.some(c => c.role === 'select' && c.key === 'agent'), 'the select is still there');
  const saved = await gui.until(s => s.agent === 'claude', 'the desktop holds the agent it was given');
  assert.equal(saved.agent, 'claude');

  /* An agent this machine has not got is offered and REFUSED: the list still names it, and
     pressing it changes nothing. */
  await gui.control('select', 'agent', -1);
  await gui.until(s => listed(s).length > 0, 'the list opened again');
  await gui.control('dropdown', 'gemini', -1);
  const after = await gui.until(s => listed(s).length > 0, 'the list is still open');
  assert.equal(after.agent, 'claude', 'an agent that is not installed is not chosen');
  assert.ok(listed(after).length > 0, 'and the list stays open rather than pretending it took');
});

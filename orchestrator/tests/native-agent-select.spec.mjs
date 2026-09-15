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

  /* The list is fetched when the ROOT becomes known, not when the select is opened, so it is there
     before anyone presses it. Waited on the ANSWER: a list that has not arrived draws exactly like
     an empty one, and this spec passed while the real control said "No agent is installed". */
  await gui.until(s => s.agents?.known === true, 'the workspace asked for its agent menu unprompted');

  /* F219 (spec 141): NO CLI IS A DEFAULT. Nobody has chosen yet, so the select shows the first
     agent this workspace's own menu names. It used to read "codex" whatever the menu said — and
     whatever a launch with no chosen agent would actually have used, which is the misleading half.
     Read from what is DRAWN, because the label is the whole claim. */
  const before = await gui.command({ op: 'text-runs' });
  const words = before.map(run => run.text);
  assert.equal(start.agent ?? '', '', 'nobody has chosen an agent yet');
  assert.ok(words.includes('claude'), `the first agent the menu names is shown: ${words.join(' | ')}`);
  assert.ok(!words.includes('codex'), `and no CLI is assumed: ${words.join(' | ')}`);

  await gui.control('select', 'agent', -1);
  const open = await gui.until(s => listed(s).length > 0, 'the agent list opened');
  assert.deepEqual(listed(open).sort(), ['claude', 'codex', 'gemini'],
    'every agent the menu names is listed, installed or not');
  assert.ok(!listed(open).includes('none'), 'and no placeholder row among them');
  /* What each row DRAWS, not merely that it exists: the note belongs to a named agent this machine
     lacks, and an installed one carries none. A rectangle could never have shown this. */
  assert.deepEqual(open.agents.rows, [
    { title: 'claude', note: '' },
    { title: 'codex', note: '' },
    { title: 'gemini', note: 'not installed' },
  ], 'the missing agent is named and marked, the installed ones unmarked');

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

/* The two defects a screenshot found that the spec above did not (2026-09-14). */
test('a list that has not arrived says so, and the placeholder carries no note', { timeout: 90000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-agent-empty-'));
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  /* A worker that answers the menu with NO agents — the real "none installed" case, which must read
     differently from the case where the answer has not come back. */
  const sidecar = await startTasksSidecar(server, { tracker: TRACKER, menu: { agents: [], live: [] } });
  const root = await server.store.addRoot(dir);
  const gui = await nativeClient({ ...server, url: sidecar.url }, { root: root.id });
  t.after(async () => { await gui.close(); await sidecar.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await gui.until(s => s.connected, 'the desktop connects');
  await gui.until(s => s.agents?.known === true, 'the menu answered, carrying nothing');

  await gui.control('select', 'agent', -1);
  const open = await gui.until(s => listed(s).length > 0, 'the list opened on a placeholder');
  assert.deepEqual(listed(open), ['none'], 'one placeholder row, not an agent');
  /* The note is for a named agent this machine lacks. On the placeholder it drew on top of the
     row's own sentence — two strings in one row, which is what the screenshot showed. */
  assert.deepEqual(open.agents.rows, [{ title: 'No agent is installed', note: '' }],
    'one sentence in the row, and nothing drawn on top of it');

  /* Pressing it does nothing: there is nothing to choose. */
  const before = open.agent;
  await gui.control('dropdown', 'none', -1);
  const after = await gui.until(s => listed(s).length > 0, 'the list stays open');
  assert.equal(after.agent, before, 'the placeholder is not a choice');
});

test('a list still being fetched says it is looking, not that nothing is installed', { timeout: 90000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-agent-slow-'));
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  /* The menu is held back long enough to open the select while it is still in flight. This is the
     state a screenshot caught the desktop drawing as "No agent is installed" — the same
     not-yet-versus-not-there confusion the Projects modal's own spec had. */
  const sidecar = await startTasksSidecar(server, { tracker: TRACKER, menu: { ...MENU, holdMs: 4000 } });
  const root = await server.store.addRoot(dir);
  const gui = await nativeClient({ ...server, url: sidecar.url }, { root: root.id });
  t.after(async () => { await gui.close(); await sidecar.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await gui.until(s => s.connected, 'the desktop connects');

  const waiting = await gui.until(s => s.agents && s.agents.known === false, 'the menu was asked for and has not answered');
  assert.equal(waiting.agents.count, 0, 'nothing is held yet');
  await gui.control('select', 'agent', -1);
  const open = await gui.until(s => (s.agents.rows ?? []).length > 0, 'the list opened while still waiting');
  assert.deepEqual(open.agents.rows, [{ title: 'Looking for agents\u2026', note: '' }],
    'it says it is looking — an unanswered list is not an empty one');

  /* And when the answer lands, the same list becomes the agents. */
  const arrived = await gui.until(s => (s.agents.rows ?? []).length === 3, 'the answer arrived and the list filled');
  assert.deepEqual(arrived.agents.rows.map(r => r.title), ['claude', 'codex', 'gemini']);
});

/* The third defect a screenshot found (2026-09-14), and the first one the row strings above still
 * could not see: the popover was sized to the SELECT it hangs from, so "not installed" — right
 * aligned into a row narrower than name-plus-note — was drawn on top of "gemini" rather than beside
 * it. Both strings were correct; their boxes overlapped. Rows are text, overlap is geometry, so
 * this asserts on the draw list's text runs inside the popover's own rectangle.
 */
test('no two strings in the open agent list are drawn on top of each other', { timeout: 90000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-agent-overlap-'));
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const sidecar = await startTasksSidecar(server, { tracker: TRACKER, menu: MENU });
  const root = await server.store.addRoot(dir);
  const gui = await nativeClient({ ...server, url: sidecar.url }, { root: root.id });
  t.after(async () => { await gui.close(); await sidecar.close(); await server.close(); await rm(dir, { recursive: true, force: true }); });
  await gui.until(s => s.connected, 'the desktop connects');
  await gui.until(s => s.agents?.known === true, 'the agent menu answered');

  await gui.control('select', 'agent', -1);
  const open = await gui.until(s => (s.agents.rows ?? []).length === 3 && s.dropdown?.key === 'agent',
    'the agent list opened on the three agents');
  /* The note is present — without it there is nothing to collide with, and a spec that passed on a
     list with no notes would be asserting nothing. */
  assert.ok(open.agents.rows.some(r => r.note === 'not installed'), 'a row carries the note');

  const runs = await gui.command({ op: 'text-runs', x: open.dropdown.x, y: open.dropdown.y, w: open.dropdown.w, h: open.dropdown.h });
  const shown = runs.map(r => r.text).sort();
  assert.deepEqual(shown, ['claude', 'codex', 'gemini', 'not installed'],
    `the popover drew its four strings and nothing else: ${JSON.stringify(runs)}`);

  /* No two of them share a pixel. Rows are stacked, so this only ever fires within one row —
     which is exactly the name-and-note collision the screenshot showed. */
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (let i = 0; i < runs.length; i++) {
    for (let k = i + 1; k < runs.length; k++) {
      assert.ok(!hits(runs[i].visible, runs[k].visible),
        `"${runs[i].text}" and "${runs[k].text}" are drawn on top of each other: ${JSON.stringify([runs[i], runs[k]])}`);
    }
  }

  /* And each is drawn whole, not elided. A popover sized to the select rather than to its widest row still draws
     every string — clipped to a stub — so "the strings are there" is not the assertion; "each one
     is drawn at its full width, inside the popover" is. */
  for (const r of runs) {
    assert.deepEqual({ w: r.visible.w, h: r.visible.h }, { w: r.w, h: r.h },
      `"${r.text}" is drawn whole rather than clipped: ${JSON.stringify(r)}`);
    assert.ok(r.x >= open.dropdown.x && r.x + r.w <= open.dropdown.x + open.dropdown.w,
      `"${r.text}" fits inside the popover: ${JSON.stringify({ run: r, popover: open.dropdown })}`);
  }
});

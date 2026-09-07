import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

/* Line 0 has a tab, line 1 has characters outside the basic multilingual plane, line 2 is plain. The
   protocol counts UTF-16 code units, so the emoji on line 1 each count twice while the tab counts
   once — a byte count or a code-point count both get this file wrong. */
const FIXTURE = '\tint main(void)\nconst char *s = "🙂🙂";\nreturn 0;\n';

const CONTROL = process.platform === 'darwin' ? 1024 : 64;   /* KMOD_GUI : KMOD_CTRL */

async function project(root) {
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, 'a.c'), FIXTURE);
  return root;
}

test('the focused editor reports its selection in the units the protocol counts', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-ide-selection-'));
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(await project(path.join(dir, 'project')));
  const gui = await nativeClient(server, { root: root.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the workspace');
    // Nothing is reported before a file is open: there is no editor to report about.
    let state = await gui.command({ op: 'state' });
    assert.equal(state.selection, '', `an unopened workspace reports nothing: ${state.selection}`);

    await gui.control('tree-entry', 'a.c', 0);
    state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.path === 'a.c'), 'the file opens');
    const tab = state.tabs.findIndex(t => t?.type === 2 && t.path === 'a.c');
    const editor = state.controls.find(c => c.role === 'editor' && c.tab === tab) ?? state.tabs[tab];
    const [x, y, w, h] = editor.rect;
    await gui.click(x + w / 2, y + h / 2);

    // The caret alone is an empty range at wherever it sits, not silence.
    state = await gui.until(s => s.selection, 'the focused editor reports');
    assert.match(state.selection, new RegExp(`^${root.id}\\|a\\.c\\|\\d+:\\d+-\\d+:\\d+\\|\\d+$`),
      `root, path, range and revision: ${state.selection}`);
    const [, , caret] = state.selection.split('|');
    assert.equal(caret.split('-')[0], caret.split('-')[1], `with nothing selected both ends are the caret: ${caret}`);

    // Select all: the end is the last line, and its character count is what UTF-16 says.
    await gui.key('a', CONTROL);
    state = await gui.until(s => s.selection.includes('|0:0-'), 'the whole file is selected');
    const range = state.selection.split('|')[2];
    assert.equal(range, '0:0-3:0', `three newlines end the selection on line 3: ${range}`);

    // Now a selection that ends inside the emoji line, which is where the counting rule shows.
    // Shift+End on line 1 selects `const char *s = "🙂🙂";`: 19 characters in the basic plane plus
    // two astral ones. That is 23 UTF-16 units — and 21 code points, and 27 bytes, so the three
    // possible answers are all different and only one of them can pass.
    await gui.key('Home', 0); await gui.key('Down', 0); await gui.key('Home', 0);
    await gui.key('End', 1);                                   /* KMOD_LSHIFT */
    // Wait for a range that actually spans something: `1:0-1:0` is the caret arriving, not the
    // selection, and a predicate that accepts it passes before the shift is even delivered.
    state = await gui.until(s => /\|1:0-1:[1-9]/.test(s.selection), 'the emoji line is selected');
    const line = state.selection.split('|')[2];
    assert.equal(line, '1:0-1:23', `an astral character is two UTF-16 units, not one and not four bytes: ${line}`);

    // A pane that stops holding an editor stops reporting, rather than leaving a stale selection.
    await gui.control('toolbar', 'Tasks', -1);
    await delay(300);
    state = await gui.until(s => s.selection === '', 'a non-editor pane reports nothing');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

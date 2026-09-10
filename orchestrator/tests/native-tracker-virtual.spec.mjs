/* F125, spec 120. A project with a thousand tasks — ~/nolf-improved keeps 1317 — laid out, measured
 * and emitted draw commands for every row on every frame, and microui clipped almost all of it away.
 * The work was done and then thrown out.
 *
 * The oracle is the draw list itself, through the automation `stats` op: the commands a frame emits
 * must not grow with the number of tasks. A thousand-row list and a ten-row list see the same
 * viewport, so they must cost about the same to draw. Pixels are compared too — virtualising is only
 * correct if the visible frame is unchanged. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

const inventory = count => ({
  schema_version: 1, project: 'fixture', review_status: 'approved',
  features: Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    description: `Task ${i + 1}: a description long enough to be measured and trimmed the way a real inventory's is, `
      + 'because the cost this test is about is per-row text measurement as much as it is per-row layout.',
    passes: i % 3 === 0, dependencies: [], milestone: 'O1', category: 'workspace', priority: 'medium',
    acceptance_criteria: ['it holds'], evidence: ['tests/x.test.mjs: it holds'],
  })),
});

async function pixels(file) {
  const bytes = await readFile(file);
  const offset = bytes.readUInt32LE(10), width = bytes.readInt32LE(18), signed = bytes.readInt32LE(22);
  const bpp = bytes.readUInt16LE(28), height = Math.abs(signed), flip = signed > 0;
  const stride = ((width * bpp / 8 + 3) & ~3);
  return { width, height, at: (x, y) => {
    const row = flip ? height - 1 - y : y;
    const i = offset + row * stride + x * (bpp / 8);
    return bpp === 24 ? ((bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i]) : bytes.readUInt32LE(i) >>> 0;
  } };
}

test('drawing a task list costs the viewport, not the inventory', { timeout: 180000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-tracker-virtual-'));
  const root = path.join(dir, 'project');
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, 'features.json'), JSON.stringify(inventory(10)));
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const added = await server.store.addRoot(root);
  const gui = await nativeClient(server, { root: added.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the workspace');
    await gui.control('toolbar', 'Tasks', -1);

    const measure = async (count, file) => {
      await writeFile(path.join(root, 'features.json'), JSON.stringify(inventory(count)));
      await gui.control('tracker-refresh', '');
      await gui.until(s => s.tabs.find(t => t?.type === 8)?.tracker?.rows?.length === count, `${count} rows load`);
      await gui.command({ op: 'stats', reset: true });
      const state = await gui.until(s => s.tabs.some(t => t?.type === 8), 'a frame after the reset');
      assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
      const stats = await gui.command({ op: 'stats' });
      const rows = state.controls.filter(c => c.role === 'tracker-task').length;
      return { commands: stats?.commands ?? stats?.total ?? null, stats, rows };
    };

    /* Both lists are far longer than the viewport, so both fill it: the only difference between them
       is how much is BELOW the fold. A ten-row list would be a bad baseline — it is shorter than the
       viewport, so it draws fewer rows for a reason that has nothing to do with virtualising. */
    const few = await measure(200, path.join(dir, 'few.bmp'));
    const many = await measure(1300, path.join(dir, 'many.bmp'));

    assert.ok(few.commands !== null && many.commands !== null,
      `the stats op reports a command count: ${JSON.stringify(few.stats)}`);

    /* The rows a viewport can show do not change with the inventory, so neither should the rows the
       frame actually drew. A 130x list drawing 130x the rows is the defect this test exists for. */
    assert.equal(many.rows, few.rows,
      `the rows drawn are the viewport's, not the inventory's: ${many.rows} for 1300 tasks `
      + `against ${few.rows} for 200`);

    /* And the draw list itself: allow generous headroom for the two spacers and the count label, but
       nothing like proportional growth. */
    assert.ok(many.commands < few.commands * 1.2 + 32,
      `the draw list does not grow with the inventory: ${many.commands} commands for 1300 tasks `
      + `against ${few.commands} for 200`);

    /* Virtualising is only correct if what a person sees is unchanged. The first screenful of a
       1300-row list must look exactly like the first screenful of a 200-row list, for the rows they
       share — compare the band the ten rows occupy. */
    const a = await pixels(path.join(dir, 'few.bmp')), b = await pixels(path.join(dir, 'many.bmp'));
    const last = (await gui.command({ op: 'state' })).controls.filter(c => c.role === 'tracker-task');
    assert.ok(last.length > 3, 'the list drew rows to compare');
    const scale = a.width / 1280;
    const band = (last[0].rect[1] + last[0].rect[3] * 3) * scale; /* the first three rows only */
    let differing = 0;
    for (let y = last[0].rect[1] * scale; y < band; y++) {
      for (let x = 0; x < a.width; x++) if (a.at(x, y) !== b.at(x, y)) differing++;
    }
    assert.equal(differing, 0, `the visible rows render identically whatever is below them: ${differing} pixels differ`);
    /* The regression a cross-vendor review of this feature found. microui takes focus on
       `hover == id && mouse_pressed` without rechecking that the pointer is over the control, and it
       only clears a stale hover when that control is updated again — so a row that stops being
       emitted keeps its hover. Hover a row's button, scroll it far out of the window, then press
       somewhere harmless: before the fix the vanished button submitted. Decompose spawns an agent,
       so this was not cosmetic. */
    const rows = (await gui.command({ op: 'state' })).controls.filter(c => c.role === 'tracker-spawn');
    assert.ok(rows.length > 3, 'the list drew spawn controls to hover');
    const victim = rows[2];
    await gui.command({ op: 'motion', x: victim.rect[0] + victim.rect[2] / 2, y: victim.rect[1] + victim.rect[3] / 2 });
    await gui.until(() => true, 'a frame with the pointer over the button');

    /* Far enough that the row is well outside the window and its overscan. */
    for (let i = 0; i < 40; i++) await gui.command({ op: 'wheel', preciseY: -3 });
    const scrolled = await gui.until(s => !s.controls.some(c => c.role === 'tracker-spawn' && c.key === victim.key),
      'the hovered row leaves the window');

    /* Press in the pane, away from any control. Nothing may open. */
    const before = scrolled.tracker?.chooser?.kind ?? '';
    const empty = scrolled.controls.find(c => c.role === 'tracker-task');
    await gui.command({ op: 'button', x: empty.rect[0] + empty.rect[2] + 4, y: empty.rect[1] - 6, down: true });
    await gui.command({ op: 'button', x: empty.rect[0] + empty.rect[2] + 4, y: empty.rect[1] - 6, down: false });
    const after = await gui.until(() => true, 'a frame after the press');
    assert.equal(after.tracker?.chooser?.kind ?? '', before,
      `a press away from any control must not submit a button that is no longer drawn `
      + `(chooser became ${JSON.stringify(after.tracker?.chooser)})`);
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

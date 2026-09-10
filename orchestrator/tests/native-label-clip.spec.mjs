/* F115/F116 fallout, spec 118. A label drew at its cell's origin and never clipped to it, so a long
 * task title ran straight across the buttons beside it and out to the pane edge — reported twice by
 * the owner from the Tasks view. The first fix routed labels through `text_clipped`, which turned out
 * never to have clipped anything: it narrowed the box with ui_clip, and the very next ui_text called
 * apply_scissor, which restored the container's wider scissor before a glyph was drawn.
 *
 * The oracle here needs no colours and no glyph knowledge: **lengthening a title must not change one
 * pixel to the right of its own column.** Everything right of the title — the buttons, the state pill
 * — is drawn from data this edit does not touch, so any difference there is the title bleeding. Both
 * frames come from one process, so fonts, theme, backend and layout are identical by construction. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

const SHORT = 'Short title';
const LONG = 'A very long task title that keeps going well past the column it was given and would, '
  + 'before this was fixed, run straight across the Tests and Spawn buttons and out past the state '
  + 'pill to the right-hand edge of the pane, which is exactly what the owner saw twice';

const inventory = title => ({
  schema_version: 1, project: 'fixture', review_status: 'approved',
  features: [{ id: 1, description: title, passes: true, dependencies: [], milestone: 'O1', category: 'workspace', priority: 'high' }],
});

/* BMP as the backends write it: 24- or 32-bit, bottom-up when height is positive, and 32-bit frames
 * carry channel masks. Mirrors tools/render_compare.py so both readers agree about what a pixel is. */
async function pixels(file) {
  const bytes = await readFile(file);
  assert.equal(bytes.toString('latin1', 0, 2), 'BM', 'the snapshot is a BMP');
  const offset = bytes.readUInt32LE(10), header = bytes.readUInt32LE(14);
  const width = bytes.readInt32LE(18), signed = bytes.readInt32LE(22);
  const bpp = bytes.readUInt16LE(28), compression = bytes.readUInt32LE(30);
  assert.ok(bpp === 24 || bpp === 32, `only 24- and 32-bit snapshots are read, got ${bpp}`);
  const height = Math.abs(signed), flip = signed > 0;
  const stride = ((width * bpp / 8 + 3) & ~3);
  return { width, height, at: (x, y) => {
    const row = flip ? height - 1 - y : y;
    const i = offset + row * stride + x * (bpp / 8);
    if (bpp === 24) return (bytes[i + 2] << 16) | (bytes[i + 1] << 8) | bytes[i];
    return bytes.readUInt32LE(i) >>> 0;
  }, bpp, compression, header };
}

test('a longer title changes no pixel to the right of its own column', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-label-clip-'));
  const root = path.join(dir, 'project');
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, 'features.json'), JSON.stringify(inventory(SHORT), null, 2));
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const added = await server.store.addRoot(root);
  const gui = await nativeClient(server, { root: added.id });
  try {
    await gui.until(s => s.connected && s.tabs.some(t => t?.type === 1 && t.tree), 'the workspace');
    await gui.control('toolbar', 'Tasks', -1);
    let state = await gui.until(s => s.tabs.some(t => t?.type === 8 && t.tracker?.rows?.length === 1), 'the task list');

    /* The title's own column ends where the first control after it begins. */
    const tests = state.controls.find(c => c.role === 'tracker-tests' && c.key === 'F1');
    assert.ok(tests, 'the row draws its Tests caret');
    const boundary = tests.rect[0], top = tests.rect[1], bottom = top + tests.rect[3];

    const before = path.join(dir, 'short.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: before }), true);

    await writeFile(path.join(root, 'features.json'), JSON.stringify(inventory(LONG), null, 2));
    await gui.control('tracker-refresh', '');
    state = await gui.until(s => s.tabs.find(t => t?.type === 8)?.tracker?.rows?.[0]?.title === LONG, 'the long title loads');
    const after = path.join(dir, 'long.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: after }), true);

    const a = await pixels(before), b = await pixels(after);
    assert.equal(a.width, b.width, 'the same window rendered both');
    /* Controls report logical pixels; the snapshot is the drawable, which is 2x on a retina display.
       Scale rather than assume, so this reads the same on either kind of screen. */
    const scale = a.width / state.width;
    assert.ok(Number.isInteger(scale) && scale >= 1, `an integral device scale, got ${scale}`);
    const [x0, y0, y1] = [boundary * scale, top * scale, bottom * scale];

    /* Sanity: the title's own column MUST differ, or the test proves nothing about the change. */
    let changedInside = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < x0; x++) if (a.at(x, y) !== b.at(x, y)) changedInside++;
    assert.ok(changedInside > 0, 'the longer title did reach the screen inside its own column');

    let bled = 0, firstX = -1, firstY = -1;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < a.width; x++) {
        if (a.at(x, y) === b.at(x, y)) continue;
        if (firstX < 0) { firstX = x; firstY = y; }
        bled++;
      }
    }
    assert.equal(bled, 0,
      `the title bled past its column: ${bled} pixel(s) changed right of x=${x0} (device), first at ${firstX},${firstY}`);
    /* Spec 119: the row trims, so the title itself opens the whole text wrapped. */

    /* The description must WRAP, and the only self-calibrating way to see that is to measure the
       same block twice: the gap the description opens above the row after it must be LARGER for a
       long title than for a short one. A fixed threshold does not work — an earlier version used
       one and a paragraph cut to a single line still cleared it, because the block's own spacing
       ate most of the margin. Two measurements cannot be fooled that way: with no wrapping the two
       gaps are identical. */
    const blockGap = async (expect) => {
      await gui.control('tracker-task', 'F1');
      const opened = await gui.until(s => s.tracker?.chooser?.kind === 'details'
                                       && s.tracker?.chooser?.taskKey === 'F1', `${expect} detail opens`);
      assert.equal(opened.controls.filter(c => c.role === 'tracker-detail' && c.key === 'F1').length, 1,
        `${expect}: the block is drawn once, under its own row`);
      assert.ok(!opened.controls.some(c => c.role === 'tracker-detail' && c.key !== 'F1'),
        `${expect}: no other row opened one`);
      /* Measured from the task's own row, which does not move, down to the first field after the
         description. The description sits between them, so this distance IS its rendered height. */
      const head = opened.controls.find(c => c.role === 'tracker-task' && c.key === 'F1');
      const next = opened.controls.find(c => (c.role === 'tracker-detail-tags' || c.role === 'tracker-detail-criterion')
                                          && c.key === 'F1');
      assert.ok(head && next, `${expect}: the block draws the row and a field after the description`);
      const measured = next.rect[1] - (head.rect[1] + head.rect[3]);
      await gui.control('tracker-task', 'F1');            /* the title toggles, so this closes it */
      await gui.until(s => s.tracker?.chooser?.kind !== 'details', `${expect} detail closes`);
      return measured;
    };

    const longGap = await blockGap('long');
    await writeFile(path.join(root, 'features.json'), JSON.stringify(inventory(SHORT), null, 2));
    await gui.control('tracker-refresh', '');
    await gui.until(s => s.tabs.find(t => t?.type === 8)?.tracker?.rows?.[0]?.title === SHORT, 'the short title returns');
    const shortGap = await blockGap('short');
    assert.ok(longGap > shortGap,
      `a long description wraps onto more lines than a short one: ${longGap}px against ${shortGap}px`);

  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

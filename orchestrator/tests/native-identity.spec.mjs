import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';
// The default word is the product's own name, generated from one declaration (spec 108); asserting
// the constant rather than a copy of it is what keeps this test about identity and not about spelling.
import { PRODUCT_NAME } from '../runtime/product.mjs';

const run = promisify(execFile);
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

async function project(root, declaration) {
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  await writeFile(path.join(root, 'a.txt'), 'x\n');
  if (declaration) await writeFile(path.join(root, '.rengine', 'project.json'), JSON.stringify(declaration, null, 2));
  return root;
}

const DECLARED = {
  contract: 5, project: 'nolf-improved', title: 're:Lith',
  icon: { glyph: 'rL', token: 'ok' },
  formats: [{ id: 'text', title: 'Text', match: ['*.txt'], modes: ['raw'], default: 'raw' }],
};

test(`the workspace wears the project name, and ${PRODUCT_NAME} when none is declared`, { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-identity-'));
  const plain = await project(path.join(dir, 'plain'), null);
  const named = await project(path.join(dir, 'named'), DECLARED);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  // Both roots exist before the desktop connects, so the project menu lists them from the start.
  const bare = await server.store.addRoot(plain);
  const other = await server.store.addRoot(named);
  const gui = await nativeClient(server, { root: bare.id });
  try {
    // Undeclared: the default word, and it is the product's own name rather than the project's.
    let state = await gui.until(s => s.connected && s.title, 'the chrome has a title');
    assert.equal(state.title, PRODUCT_NAME, 'an undeclared project shows the default name');
    assert.equal(state.mark, 'r', 'and the default mark');
    assert.ok(state.windowTitle.startsWith(PRODUCT_NAME), `and the window title agrees: ${state.windowTitle}`);

    // The declared name reaches the chrome.
    await gui.control('toolbar', 'Root', -1);
    await gui.until(s => s.controls?.some(c => c.role === 'menu-root' && c.key === 'named'), 'the project menu lists both');
    await gui.control('menu-root', 'named', -1);
    await gui.until(s => s.root === other.id, 'the second root is selected');
    await delay(600);

    // Identity comes from the window's primary root, so selecting another root must NOT rename it.
    state = await gui.command({ op: 'state' });
    assert.equal(state.primaryRoot, bare.id, 'the primary root is the one the window opened on');
    assert.equal(state.title, PRODUCT_NAME, 'selecting another root does not rename the chrome');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('a window opened on a declared project wears its name and mark', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-identity-named-'));
  const named = await project(path.join(dir, 'named'), DECLARED);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const root = await server.store.addRoot(named);
  const gui = await nativeClient(server, { root: root.id });
  try {
    const state = await gui.until(s => s.connected && s.title === 're:Lith', 'the declared title reaches the chrome');
    assert.equal(state.mark, 'rL', 'and the declared glyph');
    assert.equal(state.primaryRoot, root.id);
    assert.match(state.windowTitle, /^re:Lith\b/, `the window title wears it too: ${state.windowTitle}`);

    // The mark is drawn in the declared token's colour, not the accent.
    const file = path.join(dir, 'brand.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
    const reference = JSON.parse(await readFile('design/cards.json', 'utf8')).presets.default;
    const { stdout } = await run(PYTHON, ['tools/bmp_probe.py', file, '--logical-width', '1280',
      `chip=12,${Math.round(reference.toolbar.height / 2)}`]);
    const chip = JSON.parse(stdout).chip;
    assert.notEqual(chip, reference.toolbar.brand, `the declared token replaces the accent: ${chip}`);
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('identity keys are refused below contract 5 and an unknown token is named', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-identity-contract-'));
  const { readDeclaration } = await import('../server/formats.mjs');
  const early = await project(path.join(dir, 'early'), { ...DECLARED, contract: 4 });
  const bad = await project(path.join(dir, 'bad'), { ...DECLARED, icon: { glyph: 'x', token: 'chartreuse' } });
  const good = await project(path.join(dir, 'good'), DECLARED);

  const declaredEarly = await readDeclaration(early);
  assert.match(declaredEarly.error ?? '', /title requires contract 5 \(declared contract 4\)/, declaredEarly.error);
  const declaredBad = await readDeclaration(bad);
  assert.match(declaredBad.error ?? '', /chartreuse.*is not a design token/, declaredBad.error);
  const declaredGood = await readDeclaration(good);
  assert.equal(declaredGood.error, undefined);
  assert.equal(declaredGood.title, 're:Lith');
  assert.deepEqual(declaredGood.icon, { glyph: 'rL', token: 'ok' });
  await rm(dir, { recursive: true, force: true });
});

// Spec 104 — a project's brand is its own artwork. The pure rasteriser has its own test
// (native_svg); this is the WIRING: the declaration reaches the chrome, the chrome draws the
// artwork instead of the glyph, and a file it cannot read falls back rather than drawing nothing.
const BRAND = {
  contract: 8, project: 'kohai', title: 'Kohai',
  icon: { image: 'brand/mark.svg' },
  wordmark: { light: 'brand/wordmark.svg', dark: 'brand/wordmark-dark.svg' },
  formats: [{ id: 'text', title: 'Text', match: ['*.txt'], modes: ['raw'], default: 'raw' }],
};

async function branded(root, declaration, files = ['mark.svg', 'wordmark.svg', 'wordmark-dark.svg']) {
  await project(root, declaration);
  await mkdir(path.join(root, 'brand'), { recursive: true });
  const assets = path.join('orchestrator', 'native', 'tests', 'fixtures');
  for (const file of files) {
    const from = file.startsWith('wordmark') ? 'wordmark.svg' : 'mark.svg';
    await writeFile(path.join(root, 'brand', file), await readFile(path.join(assets, from)));
  }
  return root;
}

test('the chrome wears declared artwork, and falls back to the glyph without it', { timeout: 90000 }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-identity-brand-')));
  const root = await branded(path.join(dir, 'kohai'), BRAND);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const added = await server.store.addRoot(root);
  const gui = await nativeClient(server, { root: added.id });
  try {
    const state = await gui.until(s => s.connected && s.title === 'Kohai', 'the declared title reaches the chrome');
    // Resolved beside the declaration, so the desktop opened a path rather than joining one.
    assert.equal(state.markImage, path.join(root, 'brand/mark.svg'));
    assert.equal(state.wordmarkLight, path.join(root, 'brand/wordmark.svg'));
    assert.equal(state.wordmarkDark, path.join(root, 'brand/wordmark-dark.svg'));
    // The window title stays TEXT — no image can reach it (spec 104 decision 8).
    assert.match(state.windowTitle, /^Kohai\b/, `the window title wears the name: ${state.windowTitle}`);

    // The artwork's own ink is on the screen. This is the assertion the state above cannot make:
    // a declaration that resolved but never rasterised would pass everything up to here.
    const file = path.join(dir, 'brand.bmp');
    assert.equal(await gui.command({ op: 'snapshot', path: file }), true);
    const height = JSON.parse(await readFile('design/cards.json', 'utf8')).presets.default.toolbar.height;
    const { stdout } = await run(PYTHON, ['tools/bmp_find.py', file, '--logical-width', '1280',
      '--region', `0,0,64,${height}`, '--colour', '#cc4f4c']);
    assert.ok(JSON.parse(stdout).count > 0, `the mark's own red reached the bar: ${stdout}`);
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('artwork that cannot be read leaves the glyph and reports the problem', { timeout: 90000 }, async () => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-identity-brand-missing-')));
  // Declares the image and ships none: the decision-7 fallback, observed rather than assumed.
  const root = await branded(path.join(dir, 'kohai'), { ...BRAND, icon: { glyph: 'Ko', token: 'err' } }, []);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  const added = await server.store.addRoot(root);
  const gui = await nativeClient(server, { root: added.id });
  try {
    const state = await gui.until(s => s.connected && s.title === 'Kohai', 'the title still reaches the chrome');
    assert.equal(state.mark, 'Ko', 'the declared glyph is what the chip falls back to');
    assert.equal(state.wordmarkLight, undefined, 'an unreadable wordmark is not offered to the chrome');
    const { readDeclaration } = await import('../server/formats.mjs');
    const declared = await readDeclaration(root);
    assert.match(declared.artworkError, /cannot be read/, 'and the problem is reported, not swallowed');
    assert.equal(declared.formats[0].id, 'text', 'while the rest of the declaration survives');
  } finally {
    await gui.close(); await server.close(); await rm(dir, { recursive: true, force: true });
  }
});

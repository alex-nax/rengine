import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server/main.mjs';
import { nativeClient } from './native-client.mjs';

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

test('the workspace wears the project name, and rEdit when none is declared', { timeout: 90000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rengine-identity-'));
  const plain = await project(path.join(dir, 'plain'), null);
  const named = await project(path.join(dir, 'named'), DECLARED);
  const server = await startServer({ stateDir: path.join(dir, 'state') });
  // Both roots exist before the desktop connects, so the project menu lists them from the start.
  const bare = await server.store.addRoot(plain);
  const other = await server.store.addRoot(named);
  const gui = await nativeClient(server, { root: bare.id });
  try {
    // Undeclared: the default word, and it is rEdit rather than the old one.
    let state = await gui.until(s => s.connected && s.title, 'the chrome has a title');
    assert.equal(state.title, 'rEdit', 'an undeclared project shows the default name');
    assert.equal(state.mark, 'r', 'and the default mark');
    assert.match(state.windowTitle, /^rEdit\b/, `and the window title agrees: ${state.windowTitle}`);

    // The declared name reaches the chrome.
    await gui.control('toolbar', 'Root', -1);
    await gui.until(s => s.controls?.some(c => c.role === 'menu-root' && c.key === 'named'), 'the project menu lists both');
    await gui.control('menu-root', 'named', -1);
    await gui.until(s => s.root === other.id, 'the second root is selected');
    await delay(600);

    // Identity comes from the window's primary root, so selecting another root must NOT rename it.
    state = await gui.command({ op: 'state' });
    assert.equal(state.primaryRoot, bare.id, 'the primary root is the one the window opened on');
    assert.equal(state.title, 'rEdit', 'selecting another root does not rename the chrome');
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

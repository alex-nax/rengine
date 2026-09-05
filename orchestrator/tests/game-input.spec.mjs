import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/main.mjs';

test('game pane releases mouse buttons outside the canvas without releasing held movement', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-input-'));
  const server = await startServer({ stateDir: directory });
  let app;
  t.after(async () => { await app?.close().catch(() => {}); await server.close(); await rm(directory, { recursive: true, force: true }); });
  const root = await server.store.addRoot(directory);
  const { item, env } = server.games.surfaces.reserve();
  const native = path.resolve('.cache/native');
  const session = await server.sessions.terminal({ rootId: root.id, type: 'game',
    command: path.join(native, process.platform === 'win32' ? 'Release/rengine_surface_fixture.exe' : 'rengine_surface_fixture'),
    args: ['--input-qualification'], env: { ...env,
      ...(process.platform === 'darwin' ? { DYLD_INSERT_LIBRARIES: path.join(native, 'librengine_surface.dylib') } : {}) } });
  item.id = session.id; server.games.items.set(session.id, item);
  app = await _electron.launch({ args: [path.resolve('orchestrator/desktop/main.cjs')],
    env: { ...process.env, RENGINE_UI_URL: `${server.url}/#${server.token}`, RENGINE_DESKTOP_STATE: path.join(directory, 'electron') } });
  const page = await app.firstWindow();
  await page.getByRole('button', { name: 'Session browser', exact: true }).click();
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  const canvas = page.getByLabel('Live NOLF game', { exact: true });
  await expect.poll(() => item.frameCount).toBeGreaterThan(3);
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  const inside = [box.x + box.width / 2, box.y + box.height / 2];
  const outside = [box.x + box.width / 2, box.y - 8];
  const logs = () => server.sessions.snapshot(session.id, true).output;
  await page.mouse.move(...inside); await page.mouse.down();
  await expect.poll(logs).toMatch(/button 1 1 /);
  await page.keyboard.down('w');
  await expect.poll(logs).toMatch(/key 26 1/);
  await page.mouse.move(...outside); await page.mouse.up();
  await expect.poll(logs).toMatch(/button 1 0 /);
  assert.doesNotMatch(logs(), /key 26 0/, 'Normal pointer release must preserve held movement.');
  await page.keyboard.up('w');
  await expect.poll(logs).toMatch(/key 26 0/);
  let offset = logs().length;
  await canvas.evaluate(node => node.addEventListener('pointerdown', event => { node.dataset.pointerId = String(event.pointerId); }));
  await page.mouse.move(...inside); await page.mouse.down({ button: 'right' });
  await page.keyboard.down('w');
  await expect.poll(() => logs().slice(offset)).toMatch(/key 26 1/);
  await page.mouse.move(inside[0] + 1, inside[1]);
  await expect.poll(() => canvas.evaluate(node => node.hasPointerCapture(Number(node.dataset.pointerId)))).toBe(true);
  await canvas.evaluate(node => node.releasePointerCapture(Number(node.dataset.pointerId)));
  await page.mouse.move(inside[0] + 2, inside[1]);
  await expect.poll(() => logs().slice(offset)).toMatch(/button 3 0 /);
  await expect.poll(() => logs().slice(offset)).toMatch(/key 26 0/);
  await page.mouse.up({ button: 'right' }); await page.keyboard.up('w');
  offset = logs().length;
  await page.keyboard.press('w');
  await expect.poll(() => logs().slice(offset)).toMatch(/key 26 1[\s\S]*key 26 0/);
  offset = logs().length;
  await page.mouse.move(...inside); await page.mouse.down(); await page.mouse.down({ button: 'right' });
  await page.mouse.move(...outside); await page.mouse.up(); await page.mouse.up({ button: 'right' });
  await expect.poll(() => logs().slice(offset)).toMatch(/button 1 1 [\s\S]*button 3 1 [\s\S]*button 1 0 [\s\S]*button 3 0 /);
  offset = logs().length;
  await page.mouse.move(...inside); await page.mouse.down(); await page.keyboard.down('w');
  await expect.poll(() => logs().slice(offset)).toMatch(/key 26 1/);
  await page.getByRole('button', { name: 'Session browser', exact: true }).focus();
  await expect.poll(() => logs().slice(offset)).toMatch(/button 1 0 /);
  await expect.poll(() => logs().slice(offset)).toMatch(/key 26 0/);
  await page.mouse.up(); await page.keyboard.up('w');
  if (process.env.RENGINE_REQUIRE_POINTER_LOCK === '1') {
    await t.test('native mouse lock requires an active desktop window', async () => {
      await app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); const window = BrowserWindow.getAllWindows()[0]; window.focus(); window.webContents.focus(); });
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
        { message: 'The desktop window must receive native focus; unlock the console session before this qualification.' }).toBe(true);
      await page.getByRole('button', { name: 'Capture mouse', exact: true }).click();
      await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(true);
      await page.keyboard.press('Escape');
      await expect.poll(() => page.evaluate(() => Boolean(document.pointerLockElement))).toBe(false);
    });
  }
  assert.equal(server.sessions.get(session.id).state, 'running');
});

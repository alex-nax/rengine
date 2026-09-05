import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/main.mjs';
import { redImage, blueImage } from './image-fixtures.mjs';
import { dragTab } from './drag.mjs';

test('image previews decode the intended root through moves, refresh and GUI restart', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-preview-'));
  const server = await startServer({ stateDir: path.join(directory, 'state') });
  const roots = [];
  for (const [name, bytes] of [['red-project', redImage], ['blue-project', blueImage]]) {
    const folder = path.join(directory, name); await mkdir(folder); await writeFile(path.join(folder, 'image.png'), bytes);
    roots.push(await server.store.addRoot(folder));
  }
  let app; let page;
  t.after(async () => { await app?.close().catch(() => {}); await server.close(); await rm(directory, { recursive: true, force: true }); });
  const launch = async () => {
    app = await _electron.launch({ args: [path.resolve('orchestrator/desktop/main.cjs')],
      env: { ...process.env, RENGINE_UI_URL: `${server.url}/#${server.token}`, RENGINE_DESKTOP_STATE: path.join(directory, 'electron') } });
    page = await app.firstWindow();
  };
  const preview = (root, file = 'image.png') => page.locator(`.image-preview[data-root="${root.id}"][data-path="${file}"]`);
  const pixel = root => preview(root).getByRole('img').evaluate(image => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, 1, 1).data];
  });
  await launch();
  await page.getByRole('button', { name: 'image.png', exact: true }).click();
  await expect(preview(roots[0]).getByRole('img')).toBeVisible({ timeout: 5000 });
  await expect.poll(() => pixel(roots[0])).toEqual([225, 65, 55, 255]);
  const formats = await preview(roots[0]).getByRole('img').evaluate(image => {
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return ['image/jpeg', 'image/webp'].map(type => canvas.toDataURL(type).split(',')[1]);
  });
  await writeFile(path.join(roots[0].path, 'sample.jpg'), Buffer.from(formats[0], 'base64'));
  await writeFile(path.join(roots[0].path, 'sample.webp'), Buffer.from(formats[1], 'base64'));
  await writeFile(path.join(roots[0].path, 'sample.gif'), Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  await page.getByTitle('Refresh project tree', { exact: true }).click();
  for (const file of ['sample.jpg', 'sample.webp', 'sample.gif']) {
    await page.getByRole('button', { name: file, exact: true }).click();
    await expect.poll(() => preview(roots[0], file).getByRole('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  }
  await page.locator('.flexlayout__tab_button').filter({ hasText: 'image.png' }).click();
  await page.getByRole('button', { name: 'Actual size', exact: true }).click();
  await page.getByRole('button', { name: 'Split right', exact: true }).click();
  const destination = await dragTab(page, page.locator('.flexlayout__tab_button').filter({ hasText: 'image.png' }), page.locator('.empty-pane').last());
  await expect.poll(async () => (await preview(roots[0]).boundingBox()).x).toBeGreaterThanOrEqual(destination.x - 2);
  await expect.poll(() => pixel(roots[0])).toEqual([225, 65, 55, 255]);
  await page.getByLabel('Project for new sessions', { exact: true }).selectOption(roots[1].id);
  await page.getByRole('button', { name: 'Project tree', exact: true }).click();
  await page.getByRole('tabpanel', { name: roots[1].name, exact: true }).getByRole('button', { name: 'image.png', exact: true }).click();
  await expect.poll(() => pixel(roots[1])).toEqual([40, 110, 225, 255]);
  await app.close();
  await launch();
  await expect.poll(() => pixel(roots[1])).toEqual([40, 110, 225, 255]);
  await writeFile(path.join(roots[1].path, 'image.png'), redImage);
  await preview(roots[1]).getByRole('button', { name: 'Refresh image', exact: true }).click();
  await expect.poll(() => pixel(roots[1])).toEqual([225, 65, 55, 255]);
  await writeFile(path.join(roots[1].path, 'image.png'), redImage.subarray(0, 33));
  await preview(roots[1]).getByRole('button', { name: 'Refresh image', exact: true }).click();
  await expect(preview(roots[1]).getByRole('alert')).toContainText('cannot decode');
  assert.equal(Object.keys(server.store.state.drafts).length, 0);
  await writeFile(path.join(roots[1].path, 'image.png'), blueImage);
  await preview(roots[1]).getByRole('button', { name: 'Refresh image', exact: true }).click();
  await expect.poll(() => pixel(roots[1])).toEqual([40, 110, 225, 255]);
  await mkdir('.cache/evidence', { recursive: true });
  await page.screenshot({ path: '.cache/evidence/image-preview.png' });
});

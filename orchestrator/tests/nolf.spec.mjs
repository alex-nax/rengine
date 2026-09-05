import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/main.mjs';
import { dragTab } from './drag.mjs';

test('actual NOLF build renders through the native surface into the desktop', { timeout: 90000 }, async t => {
  assert.ok(process.env.RENGINE_NOLF_ROOT, 'Set RENGINE_NOLF_ROOT to an actual built NOLF checkout with local game data.');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-nolf-'));
  const server = await startServer({ stateDir: directory });
  await server.store.addRoot(path.resolve(process.env.RENGINE_NOLF_ROOT));
  await mkdir('.cache/evidence', { recursive: true });
  let app; let page;
  t.after(async () => {
    for (const session of server.sessions.list()) await writeFile(`.cache/evidence/nolf-${session.type}.log`, server.sessions.snapshot(session.id, true).output);
    await page?.screenshot({ path: '.cache/evidence/nolf-desktop-final.png' }).catch(() => {});
    await app?.close().catch(() => {}); await server.close(); await rm(directory, { recursive: true, force: true });
  });
  app = await _electron.launch({ args: [path.resolve('orchestrator/desktop/main.cjs')],
    env: { ...process.env, RENGINE_UI_URL: `${server.url}/#${server.token}`, RENGINE_DESKTOP_STATE: path.join(directory, 'electron') } });
  page = await app.firstWindow();
  page.on('pageerror', error => t.diagnostic(error.message));
  await page.getByRole('button', { name: 'Launch NOLF', exact: true }).click();
  const canvas = page.getByLabel('Live NOLF game', { exact: true });
  await expect(canvas).toBeVisible();
  await expect.poll(async () => Number(await canvas.getAttribute('data-sequence')), { timeout: 30000 }).toBeGreaterThan(5);
  const session = server.sessions.list().find(session => session.type === 'game');
  assert.ok(session);
  await expect.poll(() => server.games.items.get(session.id)?.frameCount, { timeout: 30000 }).toBeGreaterThan(90);
  const item = server.games.items.get(session.id);
  assert.equal(item.status, 'Live');
  const distinct = new Set(item.latest.subarray(24).filter((_value, index) => index % 4 !== 3));
  assert.ok(distinct.size > 32, 'Game surface must contain rendered content beyond a clear color.');
  await page.screenshot({ path: '.cache/evidence/nolf-desktop.png' });
  t.diagnostic(`NOLF PID ${session.pid}; ${item.frameCount} frames; ${item.width}x${item.height}; ${distinct.size} channel values`);
  const lowerMenuInk = () => {
    let count = 0;
    for (let y = Math.floor(item.height * .51); y < item.height * .72; y++) {
      for (let x = Math.floor(item.width * .15); x < item.width * .4; x++) {
        const offset = 24 + ((item.height - 1 - y) * item.width + x) * 4;
        if (item.latest[offset] < 60 && item.latest[offset + 1] < 60 && item.latest[offset + 2] < 60) count++;
      }
    }
    return count;
  };
  const mainMenuInk = lowerMenuInk();
  assert.ok(mainMenuInk > 200, 'Main menu lower entries provide the native input reference.');
  await canvas.focus();
  await page.keyboard.press('Enter');
  await expect.poll(lowerMenuInk).toBeLessThan(mainMenuInk / 2);
  await page.screenshot({ path: '.cache/evidence/nolf-single-player.png' });
  await page.getByRole('button', { name: 'Split right', exact: true }).click();
  const destination = await dragTab(page, page.locator('.flexlayout__tab_button').filter({ hasText: 'NOLF ·' }), page.locator('.empty-pane').last());
  await expect.poll(async () => (await canvas.boundingBox()).x).toBeGreaterThanOrEqual(destination.x - 2);
  await expect(canvas).toBeVisible();
  const sequence = item.frameCount;
  await page.locator('.flexlayout__tab_button').filter({ hasText: 'NOLF ·' }).getByTitle('Close', { exact: true }).click();
  await expect(canvas).toHaveCount(0);
  assert.equal(server.sessions.get(session.id).state, 'running');
  await app.close();
  assert.equal(server.sessions.get(session.id).pid, session.pid);
  app = await _electron.launch({ args: [path.resolve('orchestrator/desktop/main.cjs')],
    env: { ...process.env, RENGINE_UI_URL: `${server.url}/#${server.token}`, RENGINE_DESKTOP_STATE: path.join(directory, 'electron') } });
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'Session browser', exact: true }).click();
  await expect(page.getByText(String(session.pid), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(page.getByLabel('Live NOLF game', { exact: true })).toBeVisible();
  await expect.poll(() => item.frameCount).toBeGreaterThan(sequence);
  await page.screenshot({ path: '.cache/evidence/nolf-reattached.png' });
  await page.getByRole('button', { name: 'Session browser', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => server.sessions.get(session.id).state).toBe('exited');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from '../launcher/sidecar.mjs';

test('production launch opens NOLF, its project and installed agent, then reuses retained sessions', { timeout: 90000 }, async t => {
  assert.ok(process.env.RENGINE_NOLF_ROOT, 'Set RENGINE_NOLF_ROOT to the built NOLF checkout with local assets.');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-command-'));
  const stateDir = path.join(directory, 'state');
  let instance; let browser; let page; let child; let output = '';
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const state = () => request(instance, 'state');
  const sessionOutput = async id => (await request(instance, `session?id=${id}`)).output;
  await mkdir('.cache/evidence', { recursive: true });
  t.after(async () => {
    await page?.screenshot({ path: '.cache/evidence/launch-command-final.png' }).catch(() => {});
    if (instance) {
      for (const session of (await state()).sessions) await writeFile(`.cache/evidence/launch-command-${session.type}.log`, await sessionOutput(session.id));
    }
    await page?.evaluate(() => window.close()).catch(() => {});
    await browser?.close().catch(() => {});
    if (instance && alive(instance.pid)) {
      process.kill(instance.pid, 'SIGTERM');
      await expect.poll(() => alive(instance.pid), { timeout: 10000 }).toBe(false);
    }
    if (child && child.exitCode === null) child.kill('SIGTERM');
    await writeFile('.cache/evidence/launch-command.log', output);
    await rm(directory, { recursive: true, force: true });
  });
  const launch = async () => {
    let launchOutput = '';
    child = spawn(process.execPath, [process.env.npm_execpath, 'start', '--', '--project', process.env.RENGINE_NOLF_ROOT,
      '--state', stateDir, '--agent', 'codex', '--launch-game', '--inspect-ui'], {
      env: { ...process.env, SHELL: '/bin/bash', RENGINE_DESKTOP_STATE: path.join(directory, 'electron') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => { launchOutput += data; output += data; });
    child.stderr.on('data', data => { launchOutput += data; output += data; });
    await expect.poll(() => {
      assert.equal(child.exitCode, null, launchOutput);
      return launchOutput.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/)?.[1];
    }, { timeout: 20000 }).toBeTruthy();
    instance = JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8'));
    browser = await chromium.connectOverCDP(launchOutput.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/)[1]);
    await expect.poll(() => browser.contexts()[0].pages().length).toBeGreaterThan(0);
    page = browser.contexts()[0].pages()[0];
    page.on('pageerror', error => t.diagnostic(error.message));
    await expect(page.getByRole('button', { name: 'Launch NOLF', exact: true })).toBeVisible();
  };
  await launch();
  const originalInstance = instance.instance;
  const first = await state();
  const root = first.roots.find(root => root.path === process.env.RENGINE_NOLF_ROOT);
  assert.ok(root);
  const sessions = first.sessions;
  assert.deepEqual(sessions.map(session => session.type).sort(), ['agent', 'game', 'terminal']);
  assert.ok(sessions.every(session => session.rootId === root.id && session.state === 'running'));
  const game = sessions.find(session => session.type === 'game');
  const agent = sessions.find(session => session.type === 'agent');
  const terminal = sessions.find(session => session.type === 'terminal');
  const canvas = () => page.getByLabel('Live NOLF game', { exact: true });
  await expect.poll(async () => Number(await canvas().getAttribute('data-sequence')), { timeout: 20000 }).toBeGreaterThan(60);
  await page.locator('.flexlayout__tab_button').filter({ hasText: agent.title }).click();
  await expect.poll(async () => {
    const titles = [...(await sessionOutput(agent.id)).matchAll(/\x1b\]0;([^\x07]*)\x07/g)].map(match => match[1]);
    return titles.some(title => title !== root.name) && titles.at(-1) === root.name;
  }, { timeout: 30000 }).toBe(true);
  await page.locator('.xterm-helper-textarea:visible').focus();
  await page.keyboard.type('/mcp verbose', { delay: 80 }); await page.keyboard.press('Enter');
  await expect.poll(() => sessionOutput(agent.id)).toMatch(/workspace_info|launch_nolf|8 tools/);
  const disk = await readFile(path.join(root.path, 'README.md'), 'utf8');
  await page.getByRole('tabpanel', { name: root.name, exact: true }).getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.locator('.cm-content:visible')).toContainText(disk.split('\n').find(line => line.trim()));
  await page.locator('.cm-content:visible').fill('rEngine launch qualification draft; source remains untouched.\n');
  const secondDirectory = path.join(directory, 'second-project');
  await mkdir(secondDirectory);
  await writeFile(path.join(secondDirectory, 'README.md'), 'Second project, same filename.\n');
  const second = await request(instance, 'roots', { path: secondDirectory });
  await page.getByRole('button', { name: 'Session browser', exact: true }).click();
  await page.getByLabel('Project for new sessions', { exact: true }).selectOption(second.id);
  await page.getByRole('button', { name: 'Project tree', exact: true }).click();
  await page.getByRole('tabpanel', { name: second.name, exact: true }).getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.locator('.cm-content:visible')).toContainText('Second project, same filename.');
  await page.locator('.cm-content:visible').fill('Saved in the second project.\n');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await expect.poll(() => readFile(path.join(secondDirectory, 'README.md'), 'utf8')).toBe('Saved in the second project.\n');
  await writeFile(path.join(secondDirectory, 'README.md'), 'External second-project edit.\n');
  await page.locator('.cm-content:visible').fill('Conflicting second-project draft.\n');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await expect(page.getByText('The file changed on disk. Your draft is retained.')).toBeVisible();
  assert.equal(await readFile(path.join(secondDirectory, 'README.md'), 'utf8'), 'External second-project edit.\n');
  await page.getByRole('button', { name: 'Discard & reload', exact: true }).click();
  assert.equal(await readFile(path.join(root.path, 'README.md'), 'utf8'), disk);
  await page.locator('.flexlayout__tab_button').filter({ hasText: 'Terminal ·' }).click();
  await page.locator('.xterm-helper-textarea:visible').focus();
  await page.keyboard.type("printf '\\nCOMBINED_%s\\n' SHELL_OK"); await page.keyboard.press('Enter');
  await expect.poll(() => sessionOutput(terminal.id)).toContain('COMBINED_SHELL_OK');
  await page.locator('.flexlayout__tab_button').filter({ hasText: 'NOLF ·' }).click();
  await expect(page.getByLabel('Project for new sessions', { exact: true })).toHaveValue(second.id);
  await page.screenshot({ path: '.cache/evidence/launch-command.png' });
  await Promise.all([page.waitForEvent('close'), page.evaluate(() => window.close()).catch(() => {})]);
  await expect.poll(() => child.exitCode).toBe(0);
  await browser.close(); browser = null; page = null;
  assert.ok((await state()).sessions.every(session => session.state === 'running'));
  await launch();
  assert.equal(instance.instance, originalInstance);
  assert.deepEqual((await state()).sessions.map(session => [session.id, session.pid]), sessions.map(session => [session.id, session.pid]));
  await expect.poll(async () => Number(await canvas().getAttribute('data-sequence'))).toBeGreaterThan(60);
  await page.getByRole('tabpanel', { name: root.name, exact: true }).getByRole('button', { name: 'README.md', exact: true }).click();
  await expect(page.locator('.cm-content:visible')).toContainText('rEngine launch qualification draft');
  assert.equal(await readFile(path.join(root.path, 'README.md'), 'utf8'), disk);
  await page.getByRole('button', { name: 'Discard & reload', exact: true }).click();
  await page.getByRole('button', { name: 'Session browser', exact: true }).click();
  const row = page.locator('.session-row').filter({ hasText: String(game.pid) });
  await row.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await state()).sessions.find(session => session.id === game.id).state).toBe('exited');
  assert.ok((await state()).sessions.filter(session => session.id !== game.id).every(session => session.state === 'running'));
  t.diagnostic(`Combined command reused sidecar and all three sessions; game PID ${game.pid}, agent PID ${agent.pid}, shell PID ${terminal.pid}.`);
});

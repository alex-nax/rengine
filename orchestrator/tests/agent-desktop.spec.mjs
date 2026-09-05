import test from 'node:test';
import assert from 'node:assert/strict';
import { _electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server/main.mjs';

test('installed Codex boots through the workspace agent launcher with its MCP integration', { timeout: 60000 }, async t => {
  assert.ok(process.env.RENGINE_NOLF_ROOT, 'Set RENGINE_NOLF_ROOT to the project to qualify.');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-agent-desktop-'));
  const server = await startServer({ stateDir: directory });
  const inputs = [];
  const input = server.sessions.input.bind(server.sessions);
  server.sessions.input = (id, data) => { inputs.push(data); return input(id, data); };
  const root = await server.store.addRoot(path.resolve(process.env.RENGINE_NOLF_ROOT));
  await mkdir('.cache/evidence', { recursive: true });
  let app; let page;
  t.after(async () => {
    for (const session of server.sessions.list()) await writeFile('.cache/evidence/installed-agent.log', server.sessions.snapshot(session.id, true).output);
    await writeFile('.cache/evidence/installed-agent-input.json', JSON.stringify(inputs));
    await page?.screenshot({ path: '.cache/evidence/installed-agent.png' }).catch(() => {});
    await app?.close().catch(() => {}); await server.close(); await rm(directory, { recursive: true, force: true });
  });
  app = await _electron.launch({ args: [path.resolve('orchestrator/desktop/main.cjs')],
    env: { ...process.env, RENGINE_UI_URL: `${server.url}/#${server.token}`, RENGINE_DESKTOP_STATE: path.join(directory, 'electron') } });
  page = await app.firstWindow();
  await page.getByLabel('Preferred CLI agent', { exact: true }).fill('codex');
  await page.getByRole('button', { name: 'Launch agent', exact: true }).click();
  await expect.poll(() => server.sessions.list().length).toBe(1);
  const session = server.sessions.list()[0];
  const output = () => server.sessions.snapshot(session.id, true).output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  await expect.poll(output, { timeout: 30000 }).toMatch(/OpenAI Codex|Welcome to Codex|Codex CLI/i);
  await expect.poll(() => {
    const titles = [...server.sessions.snapshot(session.id, true).output.matchAll(/\x1b\]0;([^\x07]*)\x07/g)].map(match => match[1]);
    return titles.some(title => title !== root.name) && titles.at(-1) === root.name;
  }, { timeout: 30000 }).toBe(true);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('/mcp verbose', { delay: 80 }); await page.keyboard.press('Enter');
  await expect.poll(output, { timeout: 15000 }).toMatch(/workspace_info|launch_nolf|8 tools/);
  assert.equal(server.sessions.get(session.id).state, 'running');
  t.diagnostic(`Installed Codex running in root ${session.rootId}; workspace MCP tools visible.`);
});

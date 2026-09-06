import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeBridge } from './native-client.mjs';
import { request } from '../launcher/sidecar.mjs';

test('normal launcher opens the declared NOLF game, source tree, editor, shell and installed Codex together', { timeout: 120000 }, async () => {
  assert.equal(process.platform, 'darwin', 'This qualification uses the macOS NOLF adapter.');
  assert.ok(process.env.RENGINE_NOLF_ROOT, 'Set RENGINE_NOLF_ROOT to an actual built NOLF checkout.');
  const source = path.resolve(process.env.RENGINE_NOLF_ROOT);
  const directory = await mkdtemp(path.resolve('.cache/native-workspace-'));
  const project = path.join(directory, 'runtime'), stateDir = path.join(directory, 'state');
  for (const sub of ['build', 'nolf/Custom', 'assets', '.rengine']) await mkdir(path.join(project, sub), { recursive: true });
  await writeFile(path.join(project, '.rengine/project.json'), JSON.stringify({ contract: 3, project: 'nolf-improved qualification',
    formats: [{ id: 'lithtech-rez', title: 'LithTech REZ archive', match: ['*.rez'], modes: ['raw'], default: 'raw' }],
    games: [{ id: 'nolf-flat', title: 'NOLF (flat)', executable: ['build/relith-nolf', 'build/Release/relith-nolf'], args: ['--flat', '--game', 'nolf', '--width', '1280', '--height', '720'],
      env: { RELITH_HIDDEN_WINDOW: '1', RELITH_SKIP_INTRO: '1' }, cwd: '', requires: ['nolf/NOLF.REZ'], surface: 'embedded' }] }));

  await copyFile(path.join(source, 'build/relith-nolf'), path.join(project, 'build/relith-nolf'), constants.COPYFILE_FICLONE);
  for (const sub of ['nolf', 'nolf/Custom', 'assets']) for (const entry of await readdir(path.join(source, sub), { withFileTypes: true })) {
    if (entry.isFile() && /\.rez$/i.test(entry.name)) await symlink(path.join(source, sub, entry.name), path.join(project, sub, entry.name));
  }
  const launch = () => nativeBridge(spawn('npm', ['start', '--', '--project', project, '--state', stateDir,
    '--agent', 'codex', '--launch-game', '--inspect-ui'], { stdio: ['pipe', 'pipe', 'pipe'] }), { timeout: 30000 });
  let gui, instance;
  try {
    gui = launch();
    let state = await gui.until(s => s.connected && s.state?.sessions.length === 3 && s.tabs.some(t => t?.sequence > 5), 'normal combined launch');
    instance = JSON.parse(await readFile(path.join(stateDir, 'sidecar.json'), 'utf8'));
    const sessions = state.state.sessions;
    const agent = sessions.find(s => s.type === 'agent'), shell = sessions.find(s => s.type === 'terminal'), game = sessions.find(s => s.type === 'game');
    assert.ok(agent?.pid && shell?.pid && game?.pid);
    const select = async id => {
      const s = await gui.command({ op: 'state' }), tab = s.tabs.find(t => t?.session === id);
      await gui.click(tab.header[0] + 40, tab.header[1] + 12);
      const ready = await gui.until(s => s.tabs.some(t => t?.session === id && t.rect[2] > 0));
      const visible = ready.tabs.find(t => t?.session === id);
      await gui.click(visible.rect[0] + 20, visible.rect[1] + 15);
    };
    await select(shell.id);
    await gui.command({ op: 'text', text: "printf 'COMBINED_%s\\n' SHELL" }); await gui.key('Return');
    await gui.until(s => s.tabs.some(t => t?.session === shell.id && t.text?.includes('COMBINED_SHELL')), 'executed shell command');
    await select(agent.id);
    state = await gui.until(s => s.tabs.some(t => t?.session === agent.id && /OpenAI Codex/.test(t.text ?? '')), 'actual Codex TUI');
    await gui.until(s => s.tabs.some(t => t?.session === agent.id && /model:/.test(t.text ?? '') && !/loading|Starting MCP/.test(t.text ?? '')), 'Codex ready');
    for (const character of '/mcp') { await gui.command({ op: 'text', text: character }); await delay(80); }
    await delay(300); await gui.key('Return');
    state = await gui.until(s => s.tabs.some(t => t?.session === agent.id && /rengine_[a-f0-9]+: connected \(8 tools\)/.test(t.text ?? '')), 'Codex connected MCP tools');
    await gui.command({ op: 'snapshot', path: path.join(directory, 'agent-mcp.bmp') });
    const originalReadme = await readFile(path.join(source, 'README.md'), 'utf8');
    let previousInput = '';
    const addProject = async projectPath => {
      await gui.control('textbox', 'project');
      for (const _ of previousInput) await gui.key('Backspace');
      for (const chunk of projectPath.match(/.{1,16}/gu)) { await gui.command({ op: 'text', text: chunk }); await delay(40); }
      previousInput = projectPath;
      await gui.control('toolbar', 'Add project');
      const s = await gui.until(s => s.state.roots.some(r => r.path === projectPath), 'project added through native textbox');
      return s.state.roots.find(r => r.path === projectPath);
    };
    const drag = async (tab, x, y) => {
      const [hx, hy] = tab.header;
      await gui.command({ op: 'motion', x: hx + 20, y: hy + 10 }); await delay(60);
      await gui.command({ op: 'button', x: hx + 20, y: hy + 10 }); await delay(60);
      await gui.command({ op: 'motion', x, y }); await delay(60);
      await gui.command({ op: 'button', x, y, down: false }); await delay(60);
    };
    const sourceRoot = await addProject(source);
    state = await gui.until(s => s.tabs.some(t => t?.type === 1 && t.root === sourceRoot.id && t.tree), 'real NOLF source tree');
    let treeIndex = state.tabs.findIndex(t => t?.type === 1 && t.root === sourceRoot.id);
    await drag(state.tabs[treeIndex], 100, 400);
    for (let i = 0; i < 80; i++) {
      state = await gui.command({ op: 'state' });
      if (state.controls.some(c => c.role === 'tree-entry' && c.key === 'README.md' && c.tab === treeIndex)) break;
      await gui.command({ op: 'motion', x: 100, y: 500 }); await delay(30);
      await gui.command({ op: 'wheel', y: -5 }); await delay(40);
    }
    await gui.control('tree-entry', 'README.md', treeIndex);
    state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.root === sourceRoot.id && t.text === originalReadme), 'real README opened');
    const sourceEditor = state.tabs.findIndex(t => t?.type === 2 && t.root === sourceRoot.id);
    let editor = state.tabs[sourceEditor];
    await gui.click(editor.rect[0] + 10, editor.rect[1] + 10);
    await gui.key('Home', 0xc0); await gui.command({ op: 'text', text: 'Native recovery draft\n' });
    state = await gui.until(s => s.tabs[sourceEditor]?.dirty, 'source draft without Save');
    const sourceDraft = state.tabs[sourceEditor].text;
    assert.equal(await readFile(path.join(source, 'README.md'), 'utf8'), originalReadme);
    await drag(state.tabs[sourceEditor], 700, 500);
    await gui.until(s => s.tabs[sourceEditor]?.rect[0] > 280 && s.tabs[sourceEditor].root === sourceRoot.id, 'dirty source editor moved');

    const editable = path.join(directory, 'editable'); await mkdir(editable);
    await writeFile(path.join(editable, 'README.md'), 'temporary project\n');
    const editRoot = await addProject(editable);
    state = await gui.until(s => s.tabs.some(t => t?.type === 1 && t.root === editRoot.id && t.tree), 'second editable tree');
    treeIndex = state.tabs.findIndex(t => t?.type === 1 && t.root === editRoot.id);
    await gui.control('tree-entry', 'README.md', treeIndex);
    state = await gui.until(s => s.tabs.some(t => t?.type === 2 && t.root === editRoot.id && t.text === 'temporary project\n'), 'same filename in second project');
    const editIndex = state.tabs.findIndex(t => t?.type === 2 && t.root === editRoot.id);
    editor = state.tabs[editIndex];
    await gui.click(editor.rect[0] + 10, editor.rect[1] + 10); await gui.key('A', 0xc0);
    await gui.command({ op: 'text', text: 'saved café 世界\n' }); await gui.key('S', 0xc0);
    await gui.until(s => s.tabs[editIndex]?.text === 'saved café 世界\n' && !s.tabs[editIndex].dirty, 'native Save');
    assert.equal(await readFile(path.join(editable, 'README.md'), 'utf8'), 'saved café 世界\n');
    await writeFile(path.join(editable, 'README.md'), 'external edit\n');
    await gui.command({ op: 'text', text: 'conflict' }); await gui.key('S', 0xc0);
    await gui.until(s => s.tabs[editIndex]?.conflict && s.tabs[editIndex].dirty, 'native external conflict');
    assert.equal(await readFile(path.join(editable, 'README.md'), 'utf8'), 'external edit\n');
    await gui.control('discard', '', editIndex);
    await gui.until(s => s.tabs[editIndex]?.text === 'external edit\n' && !s.tabs[editIndex].dirty, 'native Discard');
    assert.equal(await readFile(path.join(source, 'README.md'), 'utf8'), originalReadme);

    await select(game.id);
    state = await gui.command({ op: 'state' });
    let gameTab = state.tabs.find(t => t?.session === game.id);
    await drag(gameTab, 100, 450);
    state = await gui.until(s => s.tabs.some(t => t?.session === game.id && t.rect[0] < 100 && t.rect[2] > 0 && t.sequence > gameTab.sequence), 'live NOLF moved into narrow pane');
    gameTab = state.tabs.find(t => t?.session === game.id);
    assert.ok(gameTab.header[0] + gameTab.header[2] <= gameTab.rect[0] + gameTab.rect[2] + 6);
    assert.equal((await request(instance, `session?id=${game.id}`)).pid, game.pid);
    await gui.command({ op: 'snapshot', path: path.join(directory, 'game-narrow.bmp') });
    await drag(gameTab, 700, 450);
    await gui.until(s => s.tabs.some(t => t?.session === game.id && t.rect[0] > 280 && t.sequence > gameTab.sequence), 'live NOLF returned to wide pane');
    await select(game.id);
    state = await gui.command({ op: 'state' }); gameTab = state.tabs.find(t => t?.session === game.id);
    await gui.key('Return'); await delay(500);
    await gui.command({ op: 'snapshot', path: path.join(directory, 'game-input.bmp') });
    await gui.click(gameTab.header[0] + 142, gameTab.header[1] + 12);
    await gui.until(s => !s.layout.panes.some(p => p?.tabs.some(i => s.tabs[i]?.session === game.id)), 'game view detached');
    assert.equal((await request(instance, `session?id=${game.id}`)).state, 'running');
    await gui.control('toolbar', 'Sessions'); await gui.control('attach', game.id);
    state = await gui.until(s => s.tabs.some(t => t?.session === game.id && t.sequence > gameTab.sequence && t.rect[2] > 0), 'session browser reattachment');
    gameTab = state.tabs.find(t => t?.session === game.id);
    await gui.close(); gui = null;
    const retained = await request(instance, 'state');
    assert.deepEqual(retained.sessions.map(s => [s.id, s.pid, s.state]), sessions.map(s => [s.id, s.pid, 'running']));
    gui = launch();
    state = await gui.until(s => s.tabs[sourceEditor]?.text === sourceDraft && s.tabs[sourceEditor].dirty && s.tabs.some(t => t?.session === game.id && t.sequence > gameTab.sequence), 'same command restores drafts and game');
    assert.equal(state.state.instance, instance.instance);
    assert.deepEqual(state.state.sessions.map(s => [s.id, s.pid]), sessions.map(s => [s.id, s.pid]));
    await gui.control('toolbar', 'Sessions'); await gui.control('stop', game.id);
    state = await gui.until(s => s.state.sessions.find(s => s.id === game.id)?.state === 'exited', 'explicit session browser Stop');
    assert.equal(state.state.sessions.find(s => s.id === shell.id).state, 'running');
    assert.equal(state.state.sessions.find(s => s.id === agent.id).state, 'running');
    assert.equal(await readFile(path.join(source, 'README.md'), 'utf8'), originalReadme);
    await gui.command({ op: 'snapshot', path: path.join(directory, 'sessions-stop.bmp') });
    await writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ sessions, instance: instance.instance,
      sourceRoot: sourceRoot.id, editableRoot: editRoot.id, sourceDraft, scope: 'normal native launcher, shell, connected agent MCP, tree, two-root editing, Save/conflict/Discard, editor and live NOLF pane moves, detach/reattach, GUI restart, session browser Stop' }, null, 2));
    console.log(`Native combined evidence: ${directory}`);
  } catch (error) {
    if (gui) {
      await writeFile(path.join(directory, 'failure.json'), JSON.stringify(await gui.command({ op: 'state' }).catch(() => null), null, 2));
      await gui.command({ op: 'snapshot', path: path.join(directory, 'failure.bmp') }).catch(() => {});
    }
    throw error;
  } finally {
    await gui?.close();
    instance ??= await readFile(path.join(stateDir, 'sidecar.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (instance) {
      const state = await request(instance, 'state').catch(() => null);
      if (state?.instance === instance.instance) {
        for (const session of state.sessions) {
          const snapshot = await request(instance, `session?id=${session.id}`);
          await writeFile(path.join(directory, `${session.type}.log`), snapshot.output);
        }
        process.kill(instance.pid, 'SIGTERM');
      }
    }
  }
});

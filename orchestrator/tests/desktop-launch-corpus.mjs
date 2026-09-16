/* What `runtime/desktop.mjs` hands a desktop window, recorded before it is replaced (F159, spec 144).
 *
 *   node orchestrator/tests/desktop-launch-corpus.mjs > orchestrator/tests/desktop-launch-corpus.json
 *
 * This is a CONTRACT with the native side rather than an internal detail: the desktop reads these
 * names at startup to know which workspace it belongs to, which window it is, and what to open in
 * it. A port that renamed one, or set one that should have been absent, would produce a window that
 * starts and is subtly wrong — bound to nothing, or resuming an agent nobody asked to resume.
 *
 * The absences are the part worth recording. JavaScript drops an `undefined` value from a spawn
 * environment entirely, so `RENGINE_WINDOW_ID` is UNSET for a desktop that is not a project window,
 * while `RENGINE_INITIAL_TERMINAL` is the empty STRING for one with no terminal — two different
 * facts that a port writing `""` for both would collapse.
 *
 * Recorded by launching a real child through the real `launchDesktop` and asking it what it got, so
 * what is frozen is the environment a process actually received rather than the object handed to
 * `spawn`.
 */
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const INSTANCE = {
  url: 'http://127.0.0.1:8931',
  token: 'a'.repeat(64),
  instance: '11111111-2222-3333-4444-555555555555',
};

const binding = (extra = {}) => ({ owner: 'owner-1', view: 'view-1', root: 'root-1', ...extra });

export const CASES = [
  ['a desktop on a project and nothing else', { binding: binding() }],
  ['an empty workspace names no root at all', { binding: binding({ root: '' }) }],
  ['a project window carries its id and the title the store kept', { binding: binding({ windowId: 'window-1', title: 'Alpha' }) }],
  ['a desktop opening straight onto a terminal', { binding: binding({ terminal: 'session-1' }) }],
  ['a desktop opening onto an agent, resuming it', { binding: binding({ agent: 'session-2', resume: true }) }],
  ['a desktop opening onto an agent WITHOUT resuming it', { binding: binding({ agent: 'session-2', resume: false }) }],
  ['a desktop opening onto a game', { binding: binding({ game: 'session-3' }) }],
  ['all three initial panes at once', { binding: binding({ terminal: 'session-1', agent: 'session-2', game: 'session-3' }) }],
  ['a desktop opened for inspection takes a different argument', { binding: binding(), inspectUI: true }],
];

/* The child: it reports its own arguments and every RENGINE_* variable it was actually given —
   which is the only way to record an ABSENCE, because an object handed to `spawn` cannot show one. */
const REPORTER = `#!/usr/bin/env node
const seen = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('RENGINE_')));
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), env: seen }));
`;

export async function answers() {
  const { launchDesktop } = await import('../runtime/desktop.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-desktop-corpus-'));
  try {
    const reporter = path.join(directory, 'reporter.js');
    await writeFile(reporter, REPORTER);
    await chmod(reporter, 0o755);
    const cases = [];
    for (const [name, { binding, inspectUI = false }] of CASES) {
      const child = launchDesktop(reporter, INSTANCE, binding, { inspectUI });
      let text = '';
      child.stdout.on('data', chunk => { text += chunk; });
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      if (code !== 0) throw new Error(`the reporter exited ${code}`);
      const answer = JSON.parse(text);
      /* The environment the SUPERVISOR composes, not the one this test process happened to have:
         `launchDesktop` spreads `process.env`, so a machine with RENGINE_* set in its shell would
         otherwise record its own. Only the names desktop.mjs writes are kept. */
      const written = ['RENGINE_WORKSPACE_URL', 'RENGINE_WORKSPACE_TOKEN', 'RENGINE_WINDOW_ID', 'RENGINE_WINDOW_TITLE',
        'RENGINE_INITIAL_ROOT', 'RENGINE_INITIAL_TERMINAL', 'RENGINE_INITIAL_AGENT', 'RENGINE_INITIAL_GAME',
        'RENGINE_RESUME_AGENT', 'RENGINE_LAYERED_CHILD', 'RENGINE_CAN_RELOAD', 'RENGINE_DESKTOP_OWNER', 'RENGINE_DESKTOP_VIEW'];
      const env = {};
      for (const key of written) if (key in answer.env) env[key] = answer.env[key];
      cases.push({ name, binding, inspectUI: inspectUI === true, argv: answer.argv, env, absent: written.filter(key => !(key in answer.env)) });
    }
    return { recordedFrom: 'orchestrator/runtime/desktop.mjs', recordedAt: '2026-09-16', instance: INSTANCE,
      why: 'F173: a parity proof cannot outlive the side it compares against. This is the environment runtime/desktop.mjs actually handed a desktop process on the day red-supervisor replaced it, absences included. Never regenerate: a record that moves with the implementation proves nothing.',
      cases };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export const RECORDED = (() => {
  try { return require('./desktop-launch-corpus.json'); } catch { return null; }
})();

if (process.argv[1] && process.argv[1].endsWith('desktop-launch-corpus.mjs')) {
  process.stdout.write(`${JSON.stringify(await answers(), null, 2)}\n`);
}

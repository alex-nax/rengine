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

/* `answers()` drove `runtime/desktop.mjs` and is gone with it (F173): a parity proof cannot outlive the
 * side it compares against, so what the module SAID is the evidence now and the module that said
 * it is deleted. The cases and the record below are what the Rust is judged against, and they are
 * frozen — regenerating them from the implementation they check would prove nothing. To change
 * what is asked, add a case and record it from a checkout that still has the JavaScript, which is
 * to say from history.
 */
export const RECORDED = (() => {
  try { return require('./desktop-launch-corpus.json'); } catch { return null; }
})();

/* Run directly, this says so rather than failing on a name that is not there. A recorder whose
   subject is gone is not broken — it is finished. */
if (process.argv[1] && process.argv[1].endsWith('desktop-launch-corpus.mjs')) {
  console.error('desktop-launch-corpus.json is frozen: runtime/desktop.mjs is deleted, so there is nothing left to record from.');
  process.exit(1);
}

/* Should this pane's CLI be told to connect to the editor it is running inside? (spec 102, F103)
 *
 * Claude Code auto-connects with `--ide` only when exactly one valid IDE is offered, and it decides
 * "valid" by one rule that was measured rather than assumed: a lock whose `workspaceFolders` contain
 * the working directory, with a live pid. The ancestry check its source also contains did **not**
 * apply in a real pane — a lock belonging to another machine-mate's workspace was offered alongside
 * ours — so this counts the way the CLI actually counted, not the way its code reads.
 *
 * Passing the flag when two are offered would make a person answer a menu they did not open, on
 * every pane launch. So the rule here is the CLI's own: exactly one, and it is ours.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ideDirectory, IDE_NAME } from '../runtime/ide.mjs';
import { recipe } from './registry.mjs';

const living = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/* NFC and a path-boundary test, because `/work/rengine-old` is not inside `/work/rengine`. */
const covers = (folder, directory) => {
  const a = path.resolve(folder).normalize('NFC'), b = path.resolve(directory).normalize('NFC');
  return a === b || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
};

export async function offeredEditors(directory, { locks = ideDirectory(), alive = living } = {}) {
  let names = [];
  try { names = await readdir(locks); } catch { return []; }
  const found = [];
  for (const name of names) {
    if (!name.endsWith('.lock')) continue;
    let value;
    try { value = JSON.parse(await readFile(path.join(locks, name), 'utf8')); } catch { continue; }
    if (!Number.isInteger(value?.pid) || !alive(value.pid)) continue;
    if (!Array.isArray(value.workspaceFolders) || !value.workspaceFolders.some(folder => typeof folder === 'string' && covers(folder, directory))) continue;
    found.push({ port: Number(path.basename(name, '.lock')), ideName: value.ideName, pid: value.pid, ours: value.ideName === IDE_NAME });
  }
  return found;
}

/* Which CLIs accept being told to connect on startup, and what says it: the recipe's `ide` block.
   A CLI whose recipe names none launches exactly as it does today, with nothing added to its
   command line. */
export const ideConnectFlag = agent => recipe(agent)?.ide?.flags ?? null;

/* The decision, its environment, and the sentence explaining it — a pane that silently does not
   connect is a support question, so the reason is always available even when the answer is "no".
   See sidecar: naming-the-port-beats-counting. */
export async function autoConnect(agent, directory, options = {}) {
  /* Which published editor is *this pane's*. The session host is an ancestor of every pane it forks,
     so its pid appears in the chain above this process — which identifies our editor on any host,
     including one too old to report its own pid on /api/state. */
  const ourPids = (options.ourPids ?? []).filter(Number.isInteger);
  const flags = ideConnectFlag(agent);
  if (!flags) return { flags: [], env: {}, reason: `${agent} has no auto-connect option; nothing was added to its command line.` };
  const offered = await offeredEditors(directory, options);
  if (!offered.length) return { flags: [], env: {}, reason: 'No editor is published for this directory, so auto-connect would fail at startup.' };

  /* This workspace's own editor is the one whose lock names this pane's session host. Naming its
     port makes the CLI select it outright, which is the difference between connecting to the right
     editor and declining because a machine-mate's workspace also binds this folder. */
  const ours = ourPids.length ? offered.find(editor => ourPids.includes(editor.pid) && editor.ours) : null;
  if (ours) {
    return { flags, env: { CLAUDE_CODE_SSE_PORT: String(ours.port) }, offered: offered.length,
      reason: offered.length > 1
        ? `${offered.length} editors are published for this directory; connecting to this workspace's own on port ${ours.port}.`
        : `This workspace's ${IDE_NAME} is published for this directory; connecting on startup.` };
  }

  if (offered.length > 1) {
    const why = ourPids.length ? "none of them is this workspace's" : 'this workspace could not be identified among them';
    return { flags: [], env: {}, offered: offered.length,
      reason: `${offered.length} editors are published for this directory and ${why}, so there is nothing to choose; run /ide.` };
  }
  if (!offered[0].ours) return { flags: [], env: {}, reason: `The one editor published here is ${offered[0].ideName}, not ${IDE_NAME}; it is not ours to connect to.` };
  return { flags, env: {}, offered: 1, reason: `One ${IDE_NAME} is published for this directory; connecting on startup.` };
}

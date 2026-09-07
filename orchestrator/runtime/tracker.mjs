/* The tracker routes as the workspace worker serves them (spec 101).
 *
 * They live here, above the retained session host, because they need no PTY, no surface and no
 * store state — only the project root, its declaration and the workspace state directory where a
 * credential lives. That is the whole reason a routine layered update can deliver them, which the
 * host's copy of the same routes never could (KI-043). The tracker logic itself is imported; nothing
 * about a provider is repeated here.
 */
import path from 'node:path';
import { hostArguments, listProcesses, readDescriptor } from '../launcher/replace.mjs';
import { readDeclaration } from '../server/formats.mjs';
import { projectTracker } from '../server/tracker.mjs';
import { revoke, signIn } from '../server/tracker-auth.mjs';
import { fail } from './protocol.mjs';

const REMOTE = new Set(['github', 'linear']);

/* Where the host keeps its state. A host from this checkout says so on /api/state; the retained one
   does not, and is found the way --replace-host finds it: the `main.mjs --state DIR` row whose
   sidecar.json names this host's instance. The instance is the key, never the URL — the worker is
   often handed a proxy's URL — and never the first host row, since a machine runs many. */
export async function hostStateDirectory(host, state, { processes, descriptor = readDescriptor } = {}) {
  if (typeof state?.stateDir === 'string' && path.isAbsolute(state.stateDir)) return { stateDir: state.stateDir, source: 'host' };
  let rows;
  try { rows = processes ?? await listProcesses(); }
  catch (error) { return { stateDir: null, reason: `the process table could not be read (${error.message})` }; }
  for (const row of rows) {
    const args = hostArguments(row.command);
    if (!args) continue;
    let found;
    try { found = await descriptor(args.stateDir); } catch { continue; }
    if (found?.instance === host.instance) return { stateDir: args.stateDir, source: 'process-table', pid: row.pid };
  }
  return { stateDir: null, reason: `the session host does not say where its state lives, and no main.mjs --state process serves instance ${host.instance}` };
}

const unknown = located => `The workspace state directory is unknown to this worker: ${located.reason}. The local backend still reads; a remote tracker needs a host that reports its state directory (start it from this checkout, or --replace-host).`;

export async function readTasks(root, located, { refresh = false } = {}) {
  const declared = await readDeclaration(root);
  const result = await projectTracker(root, declared, { stateDirectory: located.stateDir ?? undefined, refresh });
  if (located.stateDir || !REMOTE.has(result.provider)) return result;
  /* Without the directory no credential was looked for, so "not signed in" would be a guess. */
  const { denied, signIn: offer, ...rest } = result;
  return { ...rest, rows: [], unavailable: unknown(located) };
}

const identity = async root => { const declared = await readDeclaration(root); return declared.project ?? root.id; };

export async function trackerSignIn(root, located) {
  if (!located.stateDir) fail(unknown(located), 409);
  return signIn(located.stateDir, await identity(root));
}

export async function trackerSignOut(root, located) {
  if (!located.stateDir) fail(unknown(located), 409);
  return revoke(located.stateDir, await identity(root));
}

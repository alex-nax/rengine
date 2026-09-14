/* The thin client of `red_project::devices` (F155, spec 129, KI-107).
 *
 * Whether a declared device answers — and, when it does not, in whose words — is one implementation
 * now, in `red/red-project/src/devices.rs`, judged against the answers this module used to give
 * (`orchestrator/tests/devices-corpus.json`). What stayed here is what a caller needs SYNCHRONOUSLY
 * or without a process: the reserved local device, the two pure lookups over a declaration, and the
 * two local prerequisites a dashboard action is checked against.
 *
 * The probe cache moved with the probes. It was a Map in this process; it is a file now, because
 * the implementation runs per call and the thing it protects — not waiting out an unreachable box's
 * timeout twice — is exactly what a per-call implementation would lose. It is keyed by the project
 * root rather than by a workspace, because a device's reachability is a fact about this machine and
 * that box, not about who asked.
 */
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { askProject } from './project-client.mjs';
import { resolveInRoot } from './store-client.mjs';

/* The device that is this machine. Named here because this module is what a caller asks about
   devices; the rules that validate a declared one are red-project's. */
export const LOCAL = 'local';
export const PROBE_TTL_MS = 15000; /* the window red-project honours; stated here for its readers */
export const THIS_MACHINE = { id: LOCAL, kind: LOCAL, title: 'This machine' };

/* Per PROCESS, which is what the JavaScript cache was: a Map in the worker, lost when the worker
   was replaced. Keying the directory by the root alone made it machine-global, and `forgetProbes`
   — which takes no root — then wiped a concurrent caller's cache as well as its own. The suite
   found it as one spec probing twice because another had just cleared. */
const probeDirectory = path.join(tmpdir(), 'rengine-probes', String(process.pid));
const probeCache = rootPath => path.join(probeDirectory, `${createHash('sha256').update(rootPath).digest('hex').slice(0, 32)}.json`);
/** The cache a game preflight shares with the two listings, so one root's probes are one cache. */
export const probeCacheFor = root => probeCache(root.path);
/* A root registered with a declaration file of its own is read from THAT file, not from the
   project's — an external declaration describes a project this workspace does not own. */
export const declarationOf = root => (root?.declarationFile === undefined ? '' : root.declarationFile);
/** Drop every remembered probe, for a caller that wants the next question asked for real. */
export const forgetProbes = () => rm(probeDirectory, { recursive: true, force: true });

export async function present(root, relative) { try { await resolveInRoot(root, relative); return true; } catch { return false; } }
/* The implicit local device is always offered, so a consumer never has to declare it to bind to it
   or to see it listed; a declared one wins so its own title is used.
   See sidecar: red/red-project/src/devices.rs._llm.json#implicit-local — this is the JS copy of a
   rule the reader on the other side applies too, and the two must not drift. */
export function declaredDevices(declared) {
  const records = Array.isArray(declared?.devices) ? declared.devices : [];
  return records.some(device => device?.id === LOCAL) ? records : [THIS_MACHINE, ...records];
}
export function deviceFor(declared, id) {
  const records = declaredDevices(declared);
  return records.find(device => device.id === (id ?? LOCAL)) ?? null;
}
/* Both listings come from ONE run of red-project, because they share a probe cache: the dashboard
   asks each action's device whether it answers, and this tab asks the dashboard what is bound to
   each one. `declared` is still taken, and still ignored — the reader reads it again on the other
   side — so every caller of this module keeps its signature. */
export async function workspaceListings(root, options = {}) {
  /* `controls` was a `resolve` function the caller handed in; there is nothing to hand in now, so
     it is a flag. A caller that only wants to know which boxes answer still gets the lighter
     payload it always got. */
  const flags = [options.refresh ? 'refresh' : '', typeof options.resolve === 'function' ? 'controls' : ''].filter(Boolean).join(',');
  return askProject(['workspace', root.id, root.path, flags, probeCache(root.path), declarationOf(root)]);
}
export async function projectDevices(root, declared, options = {}) {
  return (await workspaceListings(root, options)).devices;
}

import { stat, access, constants } from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './formats.mjs';
import { LOCAL } from './device-rules.mjs';
import { resolveInRoot } from './store.mjs';
import { shellEnvironment } from './sessions.mjs';

export const PROBE_TTL_MS = 15000; /* see sidecar: probe-cache */
export const PROBE_TIMEOUT_MS = 5000;
export const PROBE_MAX_BYTES = 64 * 1024;
const CACHE_LIMIT = 256;
export const THIS_MACHINE = { id: LOCAL, kind: LOCAL, title: 'This machine' };

export async function present(root, relative) { try { await resolveInRoot(root, relative); return true; } catch { return false; } }
export async function onPath(name) {
  const env = shellEnvironment(), key = Object.keys(env).find(k => k.toLowerCase() === 'path');
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (env[key] ?? '').split(path.delimiter).filter(Boolean)) for (const extension of extensions) {
    const candidate = path.join(directory, name + extension);
    try { if ((await stat(candidate)).isFile()) { await access(candidate, constants.X_OK); return true; } } catch { /* next candidate */ }
  }
  return false;
}

const label = device => `${device.title} (${device.id})`;
export const isLocal = device => device.kind === LOCAL;
/* The implicit local device is always offered, so a consumer never has to declare it to bind to it
   or to see it listed; a declared one wins so its own title is used. See sidecar: implicit-local. */
export function declaredDevices(declared) {
  const records = Array.isArray(declared?.devices) ? declared.devices : [];
  return records.some(device => device?.id === LOCAL) ? records : [THIS_MACHINE, ...records];
}
export function deviceFor(declared, id) {
  const records = declaredDevices(declared);
  return records.find(device => device.id === (id ?? LOCAL)) ?? null;
}
/* value or env; an env that is unset or empty is a named reason, never a spawn with an empty
   argument and never one with the placeholder left in. See sidecar: placeholder-resolution. */
function resolveValue(node, field, environment) {
  if (!node || typeof node !== 'object') return { missing: `it declares no ${field}` };
  if (node.value !== undefined) return node.value ? { value: node.value } : { missing: `its ${field} is empty` };
  const key = node.env, raw = environment[key];
  if (raw === undefined) return { missing: `${key} is not set in the workspace environment` };
  if (!raw.length) return { missing: `${key} is empty in the workspace environment` };
  return { value: raw };
}

const cache = new Map();
export function forgetProbes() { cache.clear(); }
/* A TTL alone would not help: dashboardActions resolves its actions concurrently, so the first
   checks all start before any result exists. In-flight probes are joined. See sidecar: probe-cache. */
function coalesced(key, produce) {
  const hit = cache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < PROBE_TTL_MS)) return hit.promise;
  const entry = { at: Date.now(), pending: true };
  entry.promise = produce().then(result => { entry.at = Date.now(); entry.pending = false; return result; },
    error => { cache.delete(key); throw error; });
  cache.set(key, entry);
  if (cache.size > CACHE_LIMIT) for (const stale of [...cache.keys()].slice(0, cache.size - CACHE_LIMIT)) cache.delete(stale);
  return entry.promise;
}
async function probe(root, device, argv) {
  const spec = { command: argv, timeoutMs: device.probeTimeoutMs ?? PROBE_TIMEOUT_MS, maxBytes: PROBE_MAX_BYTES };
  try {
    await runCommand(root, spec, {});
    return { reachable: true, checkedAt: new Date().toISOString(), issues: [] };
  } catch (error) {
    /* runCommand already names the exit status and the first stderr line, or the timeout. */
    const reason = String(error.message).replace(/^Command /, 'the probe ').replace(/[.\s]*$/, '');
    return { reachable: false, checkedAt: new Date().toISOString(), issues: [`${label(device)} is not reachable: ${reason}.`] };
  }
}
/* Reachability, never launchability: a green ssh probe still cannot create a GL context in a logon
   session without a window station, which is why remote launching stays with the project's own
   script. Bounded and side-effect-light rather than read-only: adb starts its own daemon.
   See sidecar: probe-contract. */
export async function deviceStatus(root, device, options = {}) {
  const base = { id: device.id, kind: device.kind, title: device.title };
  const unreachable = issues => ({ ...base, reachable: false, checkedAt: new Date().toISOString(), issues });
  const issues = [];
  /* requires and tools are LOCAL by definition even on a remote device, and are checked first:
     there is no point probing an ssh device when ssh is not installed. See sidecar: local-requires. */
  for (const name of device.requires ?? []) if (!(await present(root, name))) issues.push(`${label(device)} needs ${name}, which is missing here.`);
  for (const name of device.tools ?? []) if (!(await onPath(name))) issues.push(`${label(device)} needs ${name} on this machine's PATH.`);
  if (issues.length) return unreachable(issues);
  if (isLocal(device) || !Array.isArray(device.probe)) return { ...base, reachable: true, checkedAt: new Date().toISOString(), issues: [] };
  const environment = shellEnvironment(), values = {};
  for (const field of ['host', 'selector']) {
    if (!device.probe.some(argument => typeof argument === 'string' && argument.includes(`\${${field}}`))) continue;
    const resolved = resolveValue(device[field], field, environment);
    if (resolved.missing) return unreachable([`${label(device)} is not reachable: ${resolved.missing}.`]);
    values[field] = resolved.value;
  }
  const argv = device.probe.map(argument => argument.replace(/\$\{(host|selector)\}/g, (match, key) => values[key] ?? match));
  if (argv.some(argument => argument.includes('${'))) return unreachable([`${label(device)} is not reachable: its probe has an unresolved placeholder.`]);
  /* NUL-separated so no component can forge a boundary; the argv and timeout are in the key so
     editing the declaration or the environment variable invalidates the entry. */
  const key = [root.id, device.id, JSON.stringify(argv), device.probeTimeoutMs ?? PROBE_TIMEOUT_MS].join('\u0000');
  if (options.refresh) cache.delete(key);
  return coalesced(key, () => probe(root, device, argv)).then(result => ({ ...base, ...result }));
}
/* The failing half is named, and both halves are reported: a reachable device with a missing local
   file reports the file. See sidecar: composed-availability. */
export async function targetAvailability(root, declared, target, options = {}) {
  const device = deviceFor(declared, target?.device);
  if (!device) return { device: null, missing: [{ type: 'device', name: `Unknown device ${JSON.stringify(target?.device)} for this project.` }] };
  const status = await deviceStatus(root, device, options);
  return { device: status, missing: status.reachable ? [] : status.issues.map(name => ({ type: 'device', name })) };
}
const boundTo = (target, id) => (target?.device ?? LOCAL) === id;
export function boundTargets(declared, id) {
  return {
    games: (Array.isArray(declared?.games) ? declared.games : []).filter(game => boundTo(game, id)).map(game => game.id),
    actions: (declared?.dashboard?.groups ?? []).flatMap(group => group.actions ?? []).filter(action => boundTo(action, id)).map(action => action.id),
  };
}
/* The controls a device's targets become in the Devices tab. Availability is NOT recomputed here:
   `options.resolve` is the caller's own dashboardActions, which already composes each action's
   local prerequisites with its device's reachability, and a game's state is the same preflight the
   launch uses. Both run after every device status above, so they read the probe cache those filled
   and a control costs no probe of its own. See sidecar: bound-controls. */
async function boundControls(root, declared, statuses, options) {
  if (typeof options.resolve !== 'function') return null;
  const board = await options.resolve();
  const actions = (board.groups ?? []).flatMap(group => group.actions ?? []);
  const records = Array.isArray(declared?.games) ? declared.games : [];
  const games = new Map();
  for (const game of records) {
    let config = null;
    try { config = typeof options.preflight === 'function' ? await options.preflight(root.id, game.id) : null; }
    catch (error) { games.set(game.id, { id: game.id, title: game.title, ready: false, remote: false, issue: error.message, location: '' }); continue; }
    /* A reason the device already carries is dropped rather than restated: an unreachable device is
       one reason on one row, never the same sentence under every target bound to it. */
    const carried = new Set(statuses.get(game.device ?? LOCAL)?.issues ?? []);
    games.set(game.id, {
      id: game.id, title: game.title, ready: Boolean(config?.ready), remote: Boolean(config?.refusal),
      issue: (config?.issues ?? []).find(issue => !carried.has(issue)) ?? '', location: config?.location ?? '',
    });
  }
  return { actions, games, records };
}
export async function projectDevices(root, declared, options = {}) {
  const base = { rootId: root.id, declared: declared.declared };
  if (!declared.declared) return { ...base, devices: [] };
  if (declared.error) return { ...base, error: declared.error, devices: [] };
  if (declared.devicesError) return { ...base, contract: declared.contract, error: declared.devicesError, devices: [] };
  const records = declaredDevices(declared);
  const resolved = await Promise.all(records.map(device => deviceStatus(root, device, options)));
  const statuses = new Map(records.map((device, index) => [device.id, resolved[index]]));
  const bound = await boundControls(root, declared, statuses, options);
  const devices = records.map((device, index) => ({
    ...resolved[index],
    declared: Array.isArray(declared.devices) && declared.devices.some(item => item.id === device.id),
    probed: !isLocal(device) && Array.isArray(device.probe),
    ...boundTargets(declared, device.id),
    /* A resolved action carries the device RECORD in `device`, not the declared id, and an action
       naming an undeclared device carries none — so it lands under no device, exactly as its id
       does in `actions` above. */
    ...(bound ? {
      controls: bound.actions.filter(action => action.device?.id === device.id)
        .map(({ id, title, kind, available, missing }) => ({ id, title, kind, available, missing })),
      targets: bound.records.filter(game => boundTo(game, device.id)).map(game => bound.games.get(game.id)),
    } : {}),
  }));
  return { ...base, contract: declared.contract, refreshed: Boolean(options.refresh), devices };
}

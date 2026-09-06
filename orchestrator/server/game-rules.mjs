// Cross-field rules for the contract-3 games array and its contract-4 device binding; only the
// pure device rules are imported, so formats.mjs and games.mjs still share this without pulling in fs.
import { deviceKindOf, deviceReferenceRules, LOCAL } from './device-rules.mjs';
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/, RESERVED = /^(?:RENGINE_|DYLD_|LD_)/;
/* The surfaces that stream into a workspace pane over loopback, whether rEngine injects the adapter
   (embedded) or the game's own engine connects (cooperative). Named once so every rule about
   panes covers both rather than testing one value and forgetting the other. */
export const PANE_SURFACES = ['embedded', 'cooperative'];
export const streamsIntoPane = surface => PANE_SURFACES.includes(surface);
export const nameOf = record => typeof record?.id === 'string' && record.id ? ` (${record.id})` : ''; /* see sidecar: record-identity */
export const rootRelative = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.includes('\\') && !value.split('/').includes('..') && !value.includes('\0');
export const rootRelativeDirectory = value => value === '' || rootRelative(value); /* "" is the project root; see sidecar: working-directory */

export function gameEnvRules(env, where) {
  const errors = [];
  if (env === undefined) return errors;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return [`${where} must be an object of UPPER_SNAKE keys`];
  const entries = Object.entries(env);
  if (entries.length > 64) errors.push(`${where} allows at most 64 entries`);
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key)) errors.push(`${where} key ${key} must be UPPER_SNAKE`);
    else if (RESERVED.test(key)) errors.push(`${where} key ${key} is reserved for the workspace`);
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) errors.push(`${where}.${key} must be a literal string`);
  }
  return errors;
}
export function gamesRules(games, context = {}) {
  if (!Array.isArray(games)) return [];
  const errors = [], seen = new Set();
  games.forEach((game, index) => {
    if (!game || typeof game !== 'object' || Array.isArray(game)) return;
    const at = `$.games[${index}]`, where = at + nameOf(game);
    if (seen.has(game.id)) errors.push(`${at}.id repeats ${JSON.stringify(game.id)}`); seen.add(game.id);
    errors.push(...gameEnvRules(game.env, `${where}.env`));
    errors.push(...deviceReferenceRules(game, where, context));
    /* A pane surface reserves a loopback surface and a local PTY; it cannot describe a window on
       another machine, and remote launching is outside this contract entirely. */
    const kind = deviceKindOf(game.device, context);
    if (streamsIntoPane(game.surface) && kind && kind !== LOCAL) {
      errors.push(`${where}.surface ${JSON.stringify(game.surface)} needs the ${LOCAL} device; ${JSON.stringify(game.device)} is a ${kind} device, and rEngine does not launch on a remote device`);
    }
    (Array.isArray(game.requires) ? game.requires : []).forEach((value, n) => { if (!rootRelative(value)) errors.push(`${where}.requires[${n}] must be root-relative`); });
    if (game.cwd !== undefined && !rootRelativeDirectory(game.cwd)) errors.push(`${where}.cwd must be root-relative`);
  });
  return errors;
}

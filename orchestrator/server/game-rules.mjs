// Cross-field rules for the contract-2 game block; no imports so formats.mjs and games.mjs share them.
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/, RESERVED = /^(?:RENGINE_|DYLD_|LD_)/;
export const rootRelative = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.includes('\\') && !value.split('/').includes('..') && !value.includes('\0');

export function gameEnvRules(env, where = '$.game.env') {
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
export function gameRules(game) {
  if (!game || typeof game !== 'object' || Array.isArray(game)) return [];
  const errors = gameEnvRules(game.env);
  (Array.isArray(game.requires) ? game.requires : []).forEach((value, index) => { if (!rootRelative(value)) errors.push(`$.game.requires[${index}] must be root-relative`); });
  return errors;
}

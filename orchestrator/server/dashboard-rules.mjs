// Cross-field rules for the contract-2 dashboard and script env values; no imports so formats.mjs, dashboard.mjs and scripts.mjs share them.
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/, ENV_KEY = /^[A-Z][A-Z0-9_]*$/, SHELL = /[|;&$`]/;
const KIND_FIELDS = { script: ['script', 'args', 'env'], log: ['command', 'filters'], capture: ['command', 'into', 'format'], game: ['game', 'args'] };
const KIND_REQUIRED = { script: ['script'], log: ['command'], capture: ['command', 'into', 'format'], game: ['game'] };
const PLACEHOLDER = /\$\{/;
export const rootRelative = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.includes('\\') && !value.split('/').includes('..') && !value.includes('\0');

export function envRules(env, where = 'env') {
  const errors = [];
  if (env === undefined) return errors;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return [`${where} must be an object of UPPER_SNAKE keys`];
  const entries = Object.entries(env);
  if (entries.length > 64) errors.push(`${where} allows at most 64 entries`);
  for (const [key, value] of entries) {
    if (!ENV_KEY.test(key)) errors.push(`${where} key ${key} must be UPPER_SNAKE`);
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) errors.push(`${where}.${key} must be a literal string`);
  }
  return errors;
}
/* declared: the accepted contract-3 games array, or null when its own block already failed and a
   derived "undeclared id" error would only mislead. See sidecar: game-reference. */
export function dashboardRules(dashboard, context = {}) {
  const errors = [], groups = new Set(), actions = new Set();
  const declared = context.gamesError ? null : (Array.isArray(context.games) ? context.games : []).map(item => item?.id);
  if (!dashboard || typeof dashboard !== 'object' || !Array.isArray(dashboard.groups)) return errors;
  dashboard.groups.forEach((group, g) => {
    if (!group || typeof group !== 'object') return;
    const gw = `$.dashboard.groups[${g}]`;
    if (groups.has(group.id)) errors.push(`${gw}.id repeats ${JSON.stringify(group.id)}`); groups.add(group.id);
    (Array.isArray(group.actions) ? group.actions : []).forEach((action, i) => {
      if (!action || typeof action !== 'object') return;
      const where = `${gw}.actions[${i}]`, kind = action.kind;
      if (actions.has(action.id)) errors.push(`${where}.id repeats ${JSON.stringify(action.id)}`); actions.add(action.id);
      if (!KIND_FIELDS[kind]) return;
      for (const field of Object.keys(KIND_FIELDS).flatMap(k => KIND_FIELDS[k])) if (field in action && !KIND_FIELDS[kind].includes(field)) errors.push(`${where}.${field} is not a ${kind} field`);
      for (const field of KIND_REQUIRED[kind]) if (!(field in action)) errors.push(`${where}: ${kind} requires ${field}`);
      for (const key of ['requires', 'artifacts']) (action[key] ?? []).forEach((value, n) => { if (!rootRelative(value)) errors.push(`${where}.${key}[${n}] must be root-relative`); });
      if (kind === 'script' && typeof action.script === 'string' && (!rootRelative(action.script) || !action.script.endsWith('.sh') || SHELL.test(action.script))) errors.push(`${where}.script must be a root-relative .sh path inside the root`);
      if (kind === 'capture' && typeof action.into === 'string' && !rootRelative(action.into)) errors.push(`${where}.into must be root-relative`);
      if (kind === 'game') {
        (Array.isArray(action.args) ? action.args : []).forEach((value, n) => {
          if (typeof value !== 'string' || !value.length || PLACEHOLDER.test(value)) errors.push(`${where}.args[${n}] must be a literal argument without \${…}`);
        });
        if (declared && typeof action.game === 'string' && !declared.includes(action.game)) {
          errors.push(`${where}.game references undeclared game id ${JSON.stringify(action.game)}; this declaration declares ${declared.length ? declared.join(', ') : 'no games'}`);
        }
      }
      errors.push(...envRules(action.env, `${where}.env`));
    });
  });
  return errors;
}

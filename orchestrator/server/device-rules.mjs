// Cross-field rules for the contract-4 devices array and the device key on a game or an action;
// pure so formats.mjs, game-rules.mjs and dashboard-rules.mjs can all share them.
export const LOCAL = 'local';
export const DEVICE_CONTRACT = 4;
const PLACEHOLDER = /\$\{(host|selector)\}/g;
export const nameOf = record => typeof record?.id === 'string' && record.id ? ` (${record.id})` : '';
const rootRelative = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.includes('\\') && !value.split('/').includes('..') && !value.includes('\0');

/* value or env, never both and never neither: an absent source would spawn the literal ${host}. */
function valueRules(node, field, where) {
  if (node === undefined) return [];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [`${where}.${field} must be an object with exactly one of value or env`];
  const declared = ['value', 'env'].filter(key => node[key] !== undefined);
  return declared.length === 1 ? [] : [`${where}.${field} needs exactly one of value or env${declared.length ? ', not both' : ''}`];
}
const placeholders = probe => {
  const found = new Set();
  for (const argument of Array.isArray(probe) ? probe : []) {
    if (typeof argument !== 'string') continue;
    for (const [, key] of argument.matchAll(PLACEHOLDER)) found.add(key);
  }
  return found;
};
export function devicesRules(devices) {
  if (!Array.isArray(devices)) return [];
  const errors = [], seen = new Set();
  let locals = 0;
  devices.forEach((device, index) => {
    if (!device || typeof device !== 'object' || Array.isArray(device)) return;
    const at = `$.devices[${index}]`, where = at + nameOf(device);
    if (seen.has(device.id)) errors.push(`${at}.id repeats ${JSON.stringify(device.id)}`); seen.add(device.id);
    /* local is the implicit device every unbound target uses, so the id and the kind must agree. */
    if (device.kind === LOCAL) {
      locals += 1;
      if (locals === 2) errors.push(`${where}: only one device may declare kind ${JSON.stringify(LOCAL)}`);
      if (device.id !== LOCAL) errors.push(`${where}: a ${JSON.stringify(LOCAL)} device must use the reserved id ${JSON.stringify(LOCAL)}`);
      for (const field of ['probe', 'host', 'selector']) {
        if (device[field] !== undefined) errors.push(`${where}.${field} is not permitted on the ${LOCAL} device, which is trivially reachable`);
      }
    } else if (device.id === LOCAL) {
      errors.push(`${where}: the id ${JSON.stringify(LOCAL)} is reserved for a device of kind ${JSON.stringify(LOCAL)}`);
    } else if (device.kind !== undefined) {
      /* reachable is only ever evidence: a remote device says how it is reached. */
      if (device.probe === undefined) errors.push(`${where}.probe is required for a ${device.kind} device, so its reachability is measured rather than assumed`);
      for (const key of placeholders(device.probe)) {
        if (device[key] === undefined) errors.push(`${where}.probe names \${${key}} but the record declares no ${key}`);
      }
    }
    for (const field of ['host', 'selector']) errors.push(...valueRules(device[field], field, where));
    (Array.isArray(device.requires) ? device.requires : []).forEach((value, n) => {
      if (!rootRelative(value)) errors.push(`${where}.requires[${n}] must be root-relative; a device requires stays local even when the device is remote`);
    });
  });
  return errors;
}
/* The ids a target may name: every declared device plus the implicit local, or null when the
   devices block itself failed and a derived "undeclared id" error would only mislead. */
export function declaredDeviceIds(context) {
  if (context?.devicesError) return null;
  const declared = (Array.isArray(context?.devices) ? context.devices : []).map(device => device?.id).filter(id => typeof id === 'string');
  return declared.includes(LOCAL) ? declared : [LOCAL, ...declared];
}
/* The kind of the device a target binds to, or null when it cannot be resolved. */
export function deviceKindOf(id, context) {
  if (context?.devicesError) return null;
  if ((id ?? LOCAL) === LOCAL) return LOCAL;
  const record = (Array.isArray(context?.devices) ? context.devices : []).find(device => device?.id === id);
  return typeof record?.kind === 'string' ? record.kind : null;
}
/* The key requires contract 4 even though the schema accepts it structurally, so the message names
   the contract to update to rather than telling an operator to delete the key. */
export function deviceReferenceRules(record, where, context) {
  if (record?.device === undefined) return [];
  const contract = context?.contract;
  if (typeof contract === 'number' && contract < DEVICE_CONTRACT) {
    return [`${where}.device requires contract ${DEVICE_CONTRACT} (declared contract ${contract})`];
  }
  const ids = declaredDeviceIds(context);
  if (!ids || typeof record.device !== 'string' || ids.includes(record.device)) return [];
  return [`${where}.device references undeclared device id ${JSON.stringify(record.device)}; this declaration offers ${ids.join(', ')}`];
}

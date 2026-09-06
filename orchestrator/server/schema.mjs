// Bounded JSON Schema 2020-12 subset used by the committed contracts (see sidecar: subset-scope).
const typeOf = value => Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
const matchesType = (expected, value) => expected === 'number' ? typeof value === 'number' : expected === 'integer' ? Number.isInteger(value) : typeOf(value) === expected;

export function validateSchema(schema, value, root = schema, at = '$') {
  const errors = [];
  const check = (node, item, where) => {
    if (node.$ref) {
      if (!node.$ref.startsWith('#/')) throw new Error(`Unsupported $ref ${node.$ref}`);
      check(node.$ref.slice(2).split('/').reduce((current, key) => current?.[key], root), item, where);
    }
    for (const branch of node.allOf ?? []) check(branch, item, where);
    if (node.type !== undefined && ![node.type].flat().some(type => matchesType(type, item))) { errors.push(`${where} must be ${[node.type].flat().join(' or ')}`); return; }
    if (node.const !== undefined && JSON.stringify(item) !== JSON.stringify(node.const)) errors.push(`${where} must equal ${JSON.stringify(node.const)}`);
    if (node.enum && !node.enum.some(option => JSON.stringify(option) === JSON.stringify(item))) errors.push(`${where} must be one of ${node.enum.map(x => JSON.stringify(x)).join(', ')}`);
    if (typeof item === 'string') {
      if (node.minLength !== undefined && item.length < node.minLength) errors.push(`${where} is shorter than ${node.minLength}`);
      if (node.maxLength !== undefined && item.length > node.maxLength) errors.push(`${where} is longer than ${node.maxLength}`);
      if (node.pattern && !new RegExp(node.pattern, 'u').test(item)) errors.push(`${where} does not match ${node.pattern}`);
    }
    if (typeof item === 'number') {
      if (node.minimum !== undefined && item < node.minimum) errors.push(`${where} is below ${node.minimum}`);
      if (node.maximum !== undefined && item > node.maximum) errors.push(`${where} is above ${node.maximum}`);
    }
    if (Array.isArray(item)) {
      if (node.minItems !== undefined && item.length < node.minItems) errors.push(`${where} needs at least ${node.minItems} items`);
      if (node.maxItems !== undefined && item.length > node.maxItems) errors.push(`${where} allows at most ${node.maxItems} items`);
      if (node.uniqueItems && new Set(item.map(x => JSON.stringify(x))).size !== item.length) errors.push(`${where} repeats an item`);
      item.forEach((element, index) => check(node.prefixItems?.[index] ?? node.items ?? {}, element, `${where}[${index}]`));
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const key of node.required ?? []) if (!(key in item)) errors.push(`${where} requires ${key}`);
      for (const [key, element] of Object.entries(item)) {
        if (node.properties && key in node.properties) check(node.properties[key], element, `${where}.${key}`);
        else if (node.additionalProperties === false) errors.push(`${where} has unknown key ${key}`);
      }
    }
  };
  check(schema, value, at);
  return errors;
}

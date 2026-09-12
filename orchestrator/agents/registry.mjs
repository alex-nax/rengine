/* The declared agent recipe registry (spec 114, charter D46).
 *
 * This is the ONE place an agent's integration knowledge lives: package, install/update mode,
 * model flag, conversation start/resume spellings with their id shapes, MCP overlay kind, hooks
 * overlay kind and IDE connect. config.mjs, tasks.mjs, ide-connect.mjs and agent.sh read this
 * table rather than carrying their own, so adding an agent is a data edit — and a consumer project
 * can prove exactly that by declaring one in RENGINE_AGENT_REGISTRY_EXTRA (a TOML file of the same
 * shape) without editing rEngine at all. A recipe that omits a capability is refused by name for
 * that capability alone, by the consumer, and still works for the rest.
 *
 * Since F148a (spec 129, KI-092) the table itself is DATA: registry.toml beside this module is the
 * one document this module and the red-agents crate both parse, through the same bounded TOML
 * subset (below), so the two sides resolve identical recipes for every CLI. The parser is interim
 * by design — F149 deletes this module with it. cook() builds the functions from the atoms, and
 * the flag parsers live here too (PARSERS) because each is the read side of a resume spelling the
 * recipe declares. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID_SOURCE = String.raw`[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}`;
const UUID = new RegExp(`^${UUID_SOURCE}$`, 'i');
const KIMI_ID = `^(?:session_)?(?:${UUID_SOURCE}|[0-9A-HJKMNP-TV-Z]{26})$`;

/* What the CLI's own argv says about which conversation this launch will be, for each resume
   spelling: named (an id the CLI was given), unknown (a selection only the CLI sees — a bare
   resume/continue), or minted (nothing named, the CLI will name its own). */
export function claudeFlags(args = []) {
  let named = null, opaque = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    if (flag === '--fork-session' || flag === '-c' || flag === '--continue') opaque = true;
    else if (['--session-id', '--resume', '-r'].includes(flag)) {
      const value = inline ?? args[index + 1];
      if (inline === null) index++;
      if (UUID.test(value ?? '')) named = value.toLowerCase(); else opaque = true;
    }
  }
  if (named && !opaque) return { id: named, source: 'flag' };
  return { id: null, source: opaque ? 'unknown' : 'minted' };
}

export function kimiFlags(args = []) {
  let named = null, opaque = false;
  const ids = new RegExp(KIMI_ID, 'i');
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    if (flag === '-c' || flag === '--continue') opaque = true;
    else if (['--session', '-S', '--resume', '-r'].includes(flag)) {
      const value = inline ?? args[index + 1];
      if (inline === null) index++;
      if (ids.test(value ?? '')) named = value; else opaque = true;
    }
  }
  if (named && !opaque) return { id: named, source: 'flag' };
  return { id: null, source: opaque ? 'unknown' : 'minted' };
}

/* `codex resume <id>` is a subcommand, not a flag: the first positional decides it, flags that take
   values are skipped with their values, and a bare `codex resume` opens the CLI's own picker. */
export function codexResume(args = []) {
  const VALUE_FLAGS = new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-i', '--image']);
  let named = null, opaque = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (VALUE_FLAGS.has(arg)) { index++; continue; }
    if (arg.startsWith('-')) continue;
    if (arg === 'resume') {
      const value = args[index + 1];
      if (UUID.test(value ?? '')) named = value.toLowerCase(); else opaque = true;
    }
    break;
  }
  if (named && !opaque) return { id: named, source: 'flag' };
  return { id: null, source: opaque ? 'unknown' : 'minted' };
}

const PARSERS = { 'claude-flags': claudeFlags, 'kimi-flags': kimiFlags, 'codex-resume': codexResume };
export const MCP_OVERLAYS = ['flag', 'config-args', 'env-defaults', 'env-inline', 'project-file'];
export const HOOK_OVERLAYS = [null, 'per-launch-settings', 'per-launch-config', 'guided-bootstrap'];

/* The bounded TOML subset the registry document is written in (F148a): comments, [table] and
   [table.sub] headers, key = value with basic strings, literal strings (the id shapes carry
   backslashes), integers, booleans and one-line arrays of those. An absent capability is an
   omitted table — TOML has no null. The red-agents crate implements exactly this grammar and
   refuses the rest by name with the same file:line, so "the same document" means the same thing
   on both sides. */
function parseToml(text, name) {
  const root = {};
  const defined = new Set();
  let table = root;
  const failAt = (line, message) => { throw new Error(`${name}:${line}: ${message}`); };
  const valueAt = (source, line) => {
    if (source[0] === '"') {
      let out = '', i = 1;
      for (;;) {
        if (i >= source.length) failAt(line, 'unterminated string');
        const char = source[i];
        if (char === '"') return [out, i + 1];
        if (char === '\\') {
          const esc = source[i + 1];
          const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[esc];
          if (simple !== undefined) { out += simple; i += 2; continue; }
          if (esc === 'u') {
            const hex = source.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) failAt(line, 'a bad \\u escape');
            out += String.fromCharCode(parseInt(hex, 16)); i += 6; continue;
          }
          failAt(line, `the escape \\${esc ?? ''} is outside the registry TOML subset`);
        }
        out += char; i += 1;
      }
    }
    if (source[0] === "'") {
      const end = source.indexOf("'", 1);
      if (end < 0) failAt(line, 'unterminated literal string');
      return [source.slice(1, end), end + 1];
    }
    if (source[0] === '[') {
      const items = [];
      let i = 1;
      for (;;) {
        while (source[i] === ' ' || source[i] === '\t') i++;
        if (i >= source.length) failAt(line, 'unterminated array');
        if (source[i] === ']') return [items, i + 1];
        if (items.length) {
          if (source[i] !== ',') failAt(line, 'an array separates its values with commas');
          i++;
          while (source[i] === ' ' || source[i] === '\t') i++;
          if (i >= source.length) failAt(line, 'unterminated array');
          if (source[i] === ']') return [items, i + 1];
        }
        const [item, end] = valueAt(source.slice(i), line);
        items.push(item); i += end;
      }
    }
    const scalar = /^(true|false|[+-]?\d+)/.exec(source);
    if (scalar) {
      const end = scalar[1].length;
      const after = source[end];
      if (after === undefined || after === ' ' || after === '\t' || after === ',' || after === ']') {
        return [scalar[1] === 'true' ? true : scalar[1] === 'false' ? false : Number(scalar[1]), end];
      }
    }
    failAt(line, `${JSON.stringify(source.slice(0, 24))} is outside the registry TOML subset`);
  };
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const no = index + 1;
    let quote = null;
    const source = lines[index];
    let cut = source.length;
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quote === '"') { if (char === '\\') i++; else if (char === '"') quote = null; }
      else if (quote === "'") { if (char === "'") quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '#') { cut = i; break; }
    }
    const rest = source.slice(0, cut).trim();
    if (!rest) continue;
    if (rest.startsWith('[')) {
      if (rest.startsWith('[[') || !rest.endsWith(']')) failAt(no, 'only [table] headers are in the registry TOML subset');
      const parts = rest.slice(1, -1).trim().split('.').map(part => part.trim());
      if (!parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) failAt(no, `a bad table header [${rest.slice(1, -1)}]`);
      const dotted = parts.join('.');
      if (defined.has(dotted)) failAt(no, `the table [${dotted}] is defined twice`);
      defined.add(dotted);
      table = root;
      for (const part of parts) {
        const existing = table[part];
        if (existing !== undefined && (typeof existing !== 'object' || existing === null || Array.isArray(existing))) {
          failAt(no, `[${dotted}] meets ${part}, which is already a value`);
        }
        table = table[part] ??= {};
      }
      continue;
    }
    const eq = rest.indexOf('=');
    if (eq < 0) failAt(no, `expected a [table] header or key = value, got ${JSON.stringify(rest.slice(0, 24))}`);
    const key = rest.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) failAt(no, `a bad key ${JSON.stringify(key)}`);
    if (Object.hasOwn(table, key)) failAt(no, `${key} is defined twice`);
    const after = rest.slice(eq + 1).trim();
    if (!after) failAt(no, `${key} names no value`);
    const [parsed, end] = valueAt(after, no);
    if (after.slice(end).trim()) failAt(no, 'trailing content after a value');
    table[key] = parsed;
  }
  return root;
}

/* The ONE recipe table. Loaded at import, exactly as the const it replaces was: a malformed
   document fails the process that reads it, the way a malformed table would not have compiled. */
export const REGISTRY_DOCUMENT = fileURLToPath(new URL('./registry.toml', import.meta.url));
const SHIPPED = (() => {
  const declared = parseToml(readFileSync(REGISTRY_DOCUMENT, 'utf8'), 'orchestrator/agents/registry.toml');
  if (!declared || typeof declared !== 'object' || typeof declared.recipes !== 'object' || Array.isArray(declared.recipes) || !declared.recipes) {
    throw new Error('The agent registry must be a TOML document with a recipes table.');
  }
  return declared.recipes;
})();

function cook(cli, raw) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(cli)) throw new Error(`Invalid agent name in the registry: ${cli}`);
  if (!raw || typeof raw.package !== 'string' || !raw.package) throw new Error(`Registry recipe ${cli} names no package.`);
  if (!['self', 'reinstall'].includes(raw.update?.kind)) throw new Error(`Registry recipe ${cli} has an unknown update mode.`);
  if (raw.update.command !== undefined && !/^[a-z][a-z0-9-]*$/.test(raw.update.command))
    throw new Error(`Registry recipe ${cli} names an update subcommand that is not a single word.`);
  if (!MCP_OVERLAYS.includes(raw.mcp?.kind)) throw new Error(`Registry recipe ${cli} names an MCP overlay rEngine does not implement.`);
  if (!HOOK_OVERLAYS.includes(raw.hooks?.kind ?? null)) throw new Error(`Registry recipe ${cli} names a hooks overlay rEngine does not implement.`);
  const talk = raw.conversation ?? null;
  if (talk && !PARSERS[talk.parser]) throw new Error(`Registry recipe ${cli} names a conversation parser rEngine does not implement.`);
  return {
    cli,
    package: raw.package,
    update: raw.update,
    model: raw.model?.flag ? model => [raw.model.flag, model] : null,
    models: raw.models ?? { kind: 'none' },
    conversation: talk ? {
      start: talk.start ? id => [...talk.start.args, id] : null,
      resume: id => [...talk.resume.args, id],
      ids: new RegExp(talk.ids, 'i'),
      parse: PARSERS[talk.parser],
      short: id => (talk.short?.stripPrefix ? id.replace(new RegExp(`^${talk.short.stripPrefix}`, 'i'), '') : id).slice(0, talk.short?.length ?? 8),
      normalize: talk.normalize === 'lowercase' ? id => id.toLowerCase() : id => id,
      provider: talk.provider,
      resumeLine: id => talk.resumeLine.replace('{id}', id),
    } : null,
    mcp: raw.mcp,
    hooks: raw.hooks ?? null,
    ide: raw.ide ? { flags: raw.ide.flags, env: port => ({ [raw.ide.envVar]: String(port) }) } : null,
  };
}

const COOKED = Object.fromEntries(Object.entries(SHIPPED).map(([cli, raw]) => [cli, cook(cli, raw)]));

/* The extra file is read through the environment at call time, so a recipe added as data needs no
   process restart; the read is cached per path so hot paths stat nothing twice. F148a moved the
   file from JSON to TOML (the contract change KI-092 records): the same document shape as the
   shipped registry, parsed by the same subset. */
let cache = { key: null, raw: {}, cooked: {} };
function extra() {
  const key = process.env.RENGINE_AGENT_REGISTRY_EXTRA ?? '';
  if (cache.key === key) return cache;
  let raw = {}, cooked = {};
  if (key) {
    const declared = parseToml(readFileSync(key, 'utf8'), key);
    if (!declared || typeof declared !== 'object' || typeof declared.recipes !== 'object' || Array.isArray(declared.recipes) || !declared.recipes)
      throw new Error('An extra agent registry must be a TOML document with a recipes table.');
    raw = declared.recipes;
    cooked = Object.fromEntries(Object.entries(raw).map(([cli, entry]) => {
      if (COOKED[cli]) throw new Error(`Extra agent registry redeclares ${cli}, which is already in the registry.`);
      return [cli, cook(cli, entry)];
    }));
  }
  cache = { key, raw, cooked };
  return cache;
}

export const agentNames = () => [...Object.keys(COOKED), ...Object.keys(extra().cooked)];
export const recipe = cli => COOKED[cli] ?? extra().cooked[cli];

/* The data half of a recipe, projected the way the red-agents crate projects it: every atom with
   omitted capabilities as explicit nulls. This is the shape the cross-language parity test
   compares (agent-registry-toml.test.mjs); the cooked functions above stay the JS runtime's own. */
export function resolvedRecipes() {
  const project = raw => ({
    package: raw.package,
    update: { kind: raw.update.kind, command: raw.update.command ?? null },
    model: raw.model?.flag ? { flag: raw.model.flag } : null,
    models: { kind: raw.models?.kind ?? 'none', list: raw.models?.list ?? null, default: raw.models?.default ?? null },
    conversation: raw.conversation ? {
      start: raw.conversation.start ? { args: [...raw.conversation.start.args] } : null,
      resume: raw.conversation.resume ? { args: [...raw.conversation.resume.args] } : null,
      ids: raw.conversation.ids, parser: raw.conversation.parser,
      short: { stripPrefix: raw.conversation.short?.stripPrefix ?? null, length: raw.conversation.short?.length ?? 8 },
      normalize: raw.conversation.normalize, provider: raw.conversation.provider, resumeLine: raw.conversation.resumeLine,
    } : null,
    mcp: { kind: raw.mcp.kind, envVar: raw.mcp.envVar ?? null },
    hooks: raw.hooks ? { kind: raw.hooks.kind } : null,
    ide: raw.ide ? { flags: [...raw.ide.flags], envVar: raw.ide.envVar } : null,
  });
  const merged = { ...SHIPPED, ...extra().raw };
  return Object.fromEntries(Object.entries(merged).map(([cli, raw]) => [cli, project(raw)]));
}

/* The shell surface of the same table, so agent.sh reads what every other consumer reads. */
export function show(cli) {
  const entry = recipe(cli);
  if (!entry) return null;
  return { CLI: cli, PACKAGE: entry.package, UPDATE_KIND: entry.update.kind, UPDATE_COMMAND: entry.update.command ?? '',
    STRIP_PREFIX: entry.conversation ? (SHIPPED[cli]?.conversation?.short?.stripPrefix ?? '') : '' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, cli, field] = process.argv.slice(2);
  try {
    if (action === 'list') {
      for (const name of agentNames()) {
        const line = cli === '--names' ? name : `${name}\t${recipe(name).package}`;
        console.log(line);
      }
    } else if (action === 'show' && cli) {
      const record = show(cli);
      if (!record) throw new Error(`No agent named ${cli} is registered.`);
      if (field) {
        if (!Object.hasOwn(record, field.toUpperCase())) throw new Error(`The registry has no ${field} for ${cli}.`);
        console.log(record[field.toUpperCase()]);
      } else for (const [key, value] of Object.entries(record)) console.log(`${key}=${value}`);
    } else {
      throw new Error('Usage: node orchestrator/agents/registry.mjs list [--names] | show <agent> [field]');
    }
  } catch (error) { console.error(error.message); process.exit(2); }
}

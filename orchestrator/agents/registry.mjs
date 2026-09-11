/* The declared agent recipe registry (spec 114, charter D46).
 *
 * This is the ONE place an agent's integration knowledge lives: package, install/update mode,
 * model flag, conversation start/resume spellings with their id shapes, MCP overlay kind, hooks
 * overlay kind and IDE connect. config.mjs, tasks.mjs, ide-connect.mjs and agent.sh read this
 * table rather than carrying their own, so adding an agent is a data edit — and a consumer project
 * can prove exactly that by declaring one in RENGINE_AGENT_REGISTRY_EXTRA (a JSON file of the same
 * shape) without editing rEngine at all. A recipe that omits a capability is refused by name for
 * that capability alone, by the consumer, and still works for the rest.
 *
 * Recipes are declarative data; cook() builds the functions from the atoms so the extra file can
 * carry the same shape as JSON. Parsers live here too (PARSERS) because each is the read side of a
 * resume spelling the recipe declares. */
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

const SHIPPED = {
  claude: {
    package: '@anthropic-ai/claude-code',
    update: { kind: 'self', command: 'update' },
    model: { flag: '--model' },
    models: { kind: 'static', list: ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], default: 'claude-opus-5' },
    conversation: { start: { args: ['--session-id'] }, resume: { args: ['--resume'] }, ids: `^${UUID_SOURCE}$`, parser: 'claude-flags',
      short: { length: 8 }, normalize: 'lowercase', provider: 'claude', resumeLine: 'claude --resume {id}' },
    mcp: { kind: 'flag' },
    hooks: { kind: 'per-launch-settings' },
    ide: { flags: ['--ide'], envVar: 'CLAUDE_CODE_SSE_PORT' },
  },
  codex: {
    package: '@openai/codex',
    update: { kind: 'self', command: 'update' },
    model: { flag: '-m' },
    models: { kind: 'help' },
    conversation: { start: null, resume: { args: ['resume'] }, ids: `^${UUID_SOURCE}$`, parser: 'codex-resume',
      short: { length: 8 }, normalize: 'lowercase', provider: 'codex', resumeLine: 'codex resume {id}' },
    mcp: { kind: 'config-args' },
    hooks: { kind: 'per-launch-config' },
    ide: null,
  },
  gemini: {
    package: '@google/gemini-cli',
    update: { kind: 'reinstall' },
    model: null,
    models: { kind: 'none' },
    conversation: null,
    mcp: { kind: 'env-defaults' },
    hooks: null,
    ide: null,
  },
  opencode: {
    package: 'opencode-ai',
    update: { kind: 'self', command: 'upgrade' },
    model: null,
    models: { kind: 'none' },
    conversation: null,
    mcp: { kind: 'env-inline', envVar: 'OPENCODE_CONFIG_CONTENT' },
    hooks: null,
    ide: null,
  },
  kimi: {
    package: '@moonshot-ai/kimi-code',
    update: { kind: 'self', command: 'upgrade' },
    model: { flag: '-m' },
    models: { kind: 'none' },
    conversation: { start: null, resume: { args: ['--session'] }, ids: KIMI_ID, parser: 'kimi-flags',
      short: { stripPrefix: 'session_', length: 8 }, normalize: 'none', provider: 'kimi', resumeLine: 'kimi --session {id}' },
    mcp: { kind: 'project-file' },
    hooks: { kind: 'guided-bootstrap' },
    ide: null,
  },
};

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
   process restart; the read is cached per path so hot paths stat nothing twice. */
let cache = { key: null, value: {} };
function extra() {
  const key = process.env.RENGINE_AGENT_REGISTRY_EXTRA ?? '';
  if (cache.key === key) return cache.value;
  let value = {};
  if (key) {
    const declared = JSON.parse(readFileSync(key, 'utf8'));
    if (!declared || typeof declared !== 'object' || typeof declared.recipes !== 'object' || Array.isArray(declared.recipes) || !declared.recipes)
      throw new Error('An extra agent registry must be a JSON object with a recipes object.');
    value = Object.fromEntries(Object.entries(declared.recipes).map(([cli, raw]) => {
      if (COOKED[cli]) throw new Error(`Extra agent registry redeclares ${cli}, which is already in the registry.`);
      return [cli, cook(cli, raw)];
    }));
  }
  cache = { key, value };
  return value;
}

export const agentNames = () => [...Object.keys(COOKED), ...Object.keys(extra())];
export const recipe = cli => COOKED[cli] ?? extra()[cli];

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

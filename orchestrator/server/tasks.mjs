/* Task writes, the agent/model menu and the spawn prompts (spec 103).
 *
 * Spec 083 refused writes because neither remote API offers optimistic concurrency. That reasoning
 * stands for GitHub and Linear and is enforced here by name. For the local inventory the writer is a
 * file in this checkout and the conflict is between agents of one workspace, which is exactly what
 * the project token serialises — so the workspace writes, and never by editing JSON itself: it runs
 * the command the project declared, which is the validated path the project already trusts.
 *
 * Nothing in this module gates anything. The token gate and the per-root write lock live in the
 * worker, above these functions, because they are properties of a workspace rather than of a root.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fail } from './store-client.mjs';
import { runCommand, DEFAULT_MAX_BYTES } from './formats.mjs';
import { bashPath, shellEnvironment } from './sessions.mjs';
import { agentNames, recipe } from '../agents/registry.mjs';

const agentScript = fileURLToPath(new URL('../../scripts/agent.sh', import.meta.url));
const shippedPrompts = fileURLToPath(new URL('../templates/prompts/', import.meta.url));
export const TASK_ACTIONS = ['add', 'update', 'decompose'];
export const BRIEFS = ['task', 'decompose'];
export const PLACEHOLDERS = ['id', 'key', 'title', 'criteria', 'labels'];
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_ROW_BYTES = 64 * 1024;
const MAX_STDOUT = 32000;
/* The write is a project command like every other declared command, so it is bounded like one. */
const WRITE_TIMEOUT_MS = 60000;

/* What the menu offers when a project declares no `agents` block: the registry's recipes, each
   with the model list rEngine can offer it. A static list is rEngine's own knowledge; a list of
   kind 'help' is empty here and filled from the CLI's own --help at call time, because its names
   move faster than this file does; the rest offer none, so their panes start on the CLI's own
   default. */
export function knownAgents() {
  return agentNames().map(cli => {
    const models = recipe(cli)?.models ?? { kind: 'none' };
    return { cli, models: models.kind === 'static' ? [...models.list] : [], default: models.kind === 'static' ? models.default : '' };
  });
}

const bounded = value => String(value ?? '').slice(0, MAX_STDOUT);
const decode = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } };

/* --- the write ------------------------------------------------------------------------------- */

/* Every refusal here names what is missing and asserts that nothing ran, because that is the only
   difference a caller can act on: a write that was refused and a write that failed halfway leave
   very different inventories behind. */
export function writeCommand(declared) {
  if (!declared.declared) fail('This project declares nothing in .rengine/project.json, so it names no tracker.write command for the workspace to run. Nothing was attempted.', 415);
  if (declared.error) fail(declared.error, 415);
  if (declared.trackerError) fail(declared.trackerError, 415);
  const block = declared.tracker ?? { provider: 'local' };
  if (block.provider !== 'local') {
    fail(`This project's tracker is ${block.provider}, and the workspace writes only the local backend: neither GitHub nor Linear offers concurrency control on an issue write, so a write from here would be last-write-wins against a teammate's web edit (spec 083 decision 1, amended for local only by spec 103 decision 3). Nothing was attempted.`, 409);
  }
  if (!Array.isArray(block.write) || !block.write.length) {
    fail('This project declares no tracker.write command, so the workspace has nothing to run: the workspace never edits the inventory itself. Add tracker.write to .rengine/project.json (contract 6) naming the project’s own write command with ${json}. Nothing was attempted.', 409);
  }
  return { kind: 'text', command: block.write, timeoutMs: WRITE_TIMEOUT_MS, maxBytes: DEFAULT_MAX_BYTES };
}

/* The document that replaces ${json}: the caller's row, then the two things the workspace knows and
   the row does not. Action last, so a row carrying its own `action` cannot rename the call. */
export function writeDocument({ action, row, parent }) {
  if (!TASK_ACTIONS.includes(action)) fail(`Choose one of ${TASK_ACTIONS.join(', ')}.`);
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('A task write carries its row as a JSON object.');
  if (parent !== undefined && (typeof parent !== 'string' || !parent.length || parent.length > 128)) fail('A parent is the key of the task the new row belongs under.');
  if (action === 'decompose' && parent === undefined) fail('A decompose write is a child row and needs the parent it belongs under. Nothing was attempted.');
  const document = { ...row, ...(parent === undefined ? {} : { parent }), action };
  const json = JSON.stringify(document);
  if (json.length > MAX_ROW_BYTES) fail(`A task row is at most ${MAX_ROW_BYTES} bytes of JSON.`, 413);
  return { document, json };
}

export async function taskWrite(root, declared, data) {
  const spec = writeCommand(declared);
  const { document, json } = writeDocument(data);
  const run = await runCommand(root, spec, { json });
  const text = decode(run.stdout) ?? '';
  let result;
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object') result = parsed; } catch { /* stdout is a project's own words, not a contract */ }
  return { rootId: root.id, action: data.action, key: document.key ?? document.id ?? null,
    command: run.argv.map(argument => argument === root.path ? '.' : argument.startsWith(`${root.path}/`) ? argument.slice(root.path.length + 1) : argument),
    durationMs: run.durationMs, stdout: bounded(text), ...(result === undefined ? {} : { result }) };
}

/* --- the prompts ----------------------------------------------------------------------------- */

/* Prompts are project files rather than declaration keys (decision 7), so changing one needs no
   contract bump and no host replacement. A placeholder the project misspells is named in the
   refusal: a prompt quietly missing the task's criteria reads exactly like one that has them. */
export function renderPrompt(template, values, source) {
  const unknown = [...String(template).matchAll(/\$\{([A-Za-z0-9_]*)\}/g)].map(match => match[1]).filter(name => !PLACEHOLDERS.includes(name));
  if (unknown.length) {
    const named = [...new Set(unknown)].map(name => `\${${name}}`).join(', ');
    fail(`${source} names ${named}, which ${unknown.length === 1 ? 'is not a placeholder' : 'are not placeholders'} the workspace fills. Use ${PLACEHOLDERS.map(name => `\${${name}}`).join(', ')}. Nothing was started.`, 422);
  }
  return String(template).replace(/\$\{([A-Za-z0-9_]*)\}/g, (match, name) => values[name] ?? match);
}

export async function promptFor(root, name, values) {
  if (!BRIEFS.includes(name)) fail(`Choose a brief: ${BRIEFS.join(' or ')}.`);
  const project = path.join(root.path, '.rengine', 'prompts', `${name}.md`);
  let template, source;
  try {
    const bytes = await readFile(project);
    if (bytes.length > MAX_PROMPT_BYTES) fail(`.rengine/prompts/${name}.md exceeds ${MAX_PROMPT_BYTES} bytes.`, 413);
    template = decode(bytes) ?? fail(`.rengine/prompts/${name}.md is not UTF-8 text.`, 415);
    source = `.rengine/prompts/${name}.md`;
  } catch (error) {
    if (error.status) throw error;
    if (error.code !== 'ENOENT') throw error;
    template = await readFile(path.join(shippedPrompts, `${name}.md`), 'utf8');
    source = `rEngine's shipped ${name}.md`;
  }
  return { source, text: renderPrompt(template, values, source) };
}

/* What a row says to a prompt. The list forms are rendered here rather than in the template, so a
   project overriding the prompt writes prose and never a loop. */
export function promptValues(row) {
  return { id: String(row.id ?? ''), key: String(row.key ?? ''), title: String(row.title ?? ''),
    labels: (row.labels ?? []).join(', ') || 'none',
    criteria: (row.criteria ?? []).length
      ? row.criteria.map((item, index) => `${index + 1}. ${item}`).join('\n')
      : 'None are recorded in the inventory; establish them with the project before implementing.' };
}

/* --- the agent/model menu -------------------------------------------------------------------- */

export function modelArgs(cli, model) {
  if (model === undefined || model === null || model === '') return [];
  if (typeof model !== 'string' || model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(model)) fail('A model is a plain identifier the CLI accepts.');
  const flag = recipe(cli)?.model;
  /* A CLI whose recipe names no model flag is refused by name rather than started without the model
     the caller asked for: a spawn that silently drops the model is a pane running the wrong thing
     that looks right. */
  if (!flag) fail(`rEngine does not know how ${cli} is told which model to run, so it will not guess a flag: start ${cli} without a model, or declare the flagged CLI you meant. Nothing was started.`, 409);
  return flag(model);
}

/* clap prints its choices as "[possible values: a, b, c]"; a codex that prints none leaves the list
   empty rather than inviting a guess at names that move faster than this file does. */
export function codexModels(help = '') {
  const lines = String(help).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!/--model\b/.test(line)) continue;
    const found = /possible values:\s*([^\]\n]+)/i.exec(lines.slice(index, index + 3).join(' '));
    if (!found) continue;
    const models = found[1].split(',').map(item => item.trim().replace(/^["'`]|["'`]$/g, ''))
      .filter(item => /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(item));
    if (models.length) return models.slice(0, 32);
  }
  return [];
}

const runBounded = (file, args, timeoutMs = 10000) => new Promise(resolve => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, env: shellEnvironment(), windowsHide: true },
    (error, stdout) => resolve(error && !stdout ? '' : String(stdout ?? '')));
});
export const listInstalled = root => runBounded(bashPath(), [agentScript, '--project', root.path, '--action', 'list']);

export function parseInstalled(text) {
  const installed = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const [name, where] = line.split('\t');
    if (!name?.trim()) continue;
    installed.set(name.trim(), Boolean(where?.trim()) && where.trim() !== 'not installed');
  }
  return installed;
}

/* The menu the Tasks pane offers. A declaration wins outright — a project that lists its agents has
   said which ones it wants used — and rEngine's own lists fill in only when it has not. */
export async function agentsMenu(root, declared, options = {}) {
  const list = options.list ?? listInstalled, help = options.help ?? (cli => runBounded(cli, ['--help'], 8000));
  const installed = parseInstalled(await list(root));
  const declaredAgents = Array.isArray(declared?.agents) ? declared.agents : null;
  const records = declaredAgents ?? knownAgents();
  const agents = [];
  for (const record of records) {
    let models = [...(record.models ?? [])], fallback = record.default ?? '';
    if (!declaredAgents && recipe(record.cli)?.models.kind === 'help' && installed.get(record.cli)) {
      models = codexModels(await help(record.cli));
      fallback = models[0] ?? '';
    }
    agents.push({ cli: record.cli, installed: installed.get(record.cli) ?? false, models, default: fallback });
  }
  return { rootId: root.id, declared: Boolean(declaredAgents), agents };
}

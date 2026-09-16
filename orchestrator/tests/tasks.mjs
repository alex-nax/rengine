/* The thin client of `red_project::tasks` (F153, spec 103, spec 129).
 *
 * Spec 083 refused task writes because neither remote tracker offers concurrency control on an
 * issue write. Spec 103 decision 3 amended that for the LOCAL backend only, and only by running the
 * command the project itself declared: the workspace never edits an inventory. That boundary, the
 * prompts a spawn carries and the agent/model menu are one implementation now, in
 * `red/red-project/src/tasks.rs`, judged against the answers this module used to give
 * (`orchestrator/tests/tasks-corpus.json`).
 *
 * Nothing here gates anything. The token gate and the per-root write lock live in the worker, above
 * these functions, because they are properties of a workspace rather than of a root.
 *
 * Two things stayed. Running a CLI is this side's business — `listInstalled` shells the launcher's
 * own script and `--help` is asked of the CLI itself — and `knownAgents`/`modelArgs` are read
 * SYNCHRONOUSLY from the registry projection `agents-client.mjs` already holds, which is what a
 * caller composing an argv needs. Which CLIs the menu wants a `--help` from is NOT restated here:
 * the menu says so, and this asks it again with what it found.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { askProject } from './project-client.mjs';
import { bashPath, shellEnvironment } from '../server/sessions-client.mjs';
import { agentNames, recipe } from '../agents/agents-client.mjs';
import { fail } from '../server/store-client.mjs';

const agentScript = fileURLToPath(new URL('../../scripts/agent.sh', import.meta.url));
const ask = (call, root, input) => askProject(['tasks', call, root.id, root.path], JSON.stringify(input));

/* What the menu offers when a project declares no `agents` block: the registry's recipes, each with
   the model list rEngine can offer it. Synchronous, from the projection this process already holds,
   because a caller composing an argv has nothing to await. red-project holds the same rule for the
   day the menu is answered there; see red/red-project/src/tasks.rs._llm.json#registry-read-twice. */
export function knownAgents() {
  return agentNames().map(cli => {
    const models = recipe(cli)?.models ?? { kind: 'none' };
    return { cli, models: models.kind === 'static' ? [...models.list] : [], default: models.kind === 'static' ? models.default : '' };
  });
}
export function modelArgs(cli, model) {
  if (model === undefined || model === null || model === '') return [];
  if (typeof model !== 'string' || model.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(model)) fail('A model is a plain identifier the CLI accepts.');
  const flag = recipe(cli)?.model;
  if (!flag) fail(`rEngine does not know how ${cli} is told which model to run, so it will not guess a flag: start ${cli} without a model, or declare the flagged CLI you meant. Nothing was started.`, 409);
  return flag(model);
}

export const writeCommand = declared => ask('writeCommand', NO_ROOT, { declared });
export const writeDocument = data => ask('writeDocument', NO_ROOT, { data });
export const renderPrompt = (template, values, source) => ask('renderPrompt', NO_ROOT, { template, values, source }).then(answer => answer.text);
export const promptValues = row => ask('promptValues', NO_ROOT, { row });
export const helpModels = (help = '') => ask('helpModels', NO_ROOT, { help }).then(answer => answer.models);
export const parseInstalled = text => ask('parseInstalled', NO_ROOT, { text }).then(answer => new Map(Object.entries(answer.installed)));
export const taskWrite = (root, declared, data) => ask('taskWrite', root, { declared, data });
export const promptFor = (root, name, values) => ask('promptFor', root, { name, values });

const NO_ROOT = { id: '', path: '' };

const runBounded = (file, args, timeoutMs = 10000) => new Promise(resolve => {
  execFile(file, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, env: shellEnvironment(), windowsHide: true },
    (error, stdout) => resolve(error && !stdout ? '' : String(stdout ?? '')));
});
export const listInstalled = root => runBounded(bashPath(), [agentScript, '--project', root.path, '--action', 'list']);

/* The menu the Tasks pane offers. A declaration wins outright — a project that lists its agents has
   said which ones it wants used — and rEngine's own lists fill in only when it has not.
   Two halves: what the menu can build now, and the CLIs whose own `--help` it still wants. Asking
   rather than deciding here is what keeps "a declared menu asks no CLI anything" one rule. */
export async function agentsMenu(root, declared, options = {}) {
  const list = options.list ?? listInstalled, help = options.help ?? (cli => runBounded(cli, ['--help'], 8000));
  const installed = await list(root);
  const first = await ask('agentsMenu', root, { declared, installed, help: {} });
  if (!first.needsHelp.length) return first.menu;
  const texts = Object.fromEntries(await Promise.all(first.needsHelp.map(async cli => [cli, await help(cli)])));
  return (await ask('agentsMenu', root, { declared, installed, help: texts })).menu;
}

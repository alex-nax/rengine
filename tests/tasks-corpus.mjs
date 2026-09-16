/* The answers `tasks.mjs` gives, recorded before it is replaced (F153, spec 103, spec 129).
 *
 * The device F148/F172/F178 established and F156b/F157/F155 repeated: a replacement cannot be
 * compared against a module that no longer exists, so the module's own answers are recorded while
 * it is still here. Regenerate ONLY from a checkout where `tasks.mjs` still answers — never after
 * the deletion commit, because a regenerated record would be judging the replacement against
 * itself.
 *
 *   node tests/tasks-corpus.mjs > tests/tasks-corpus.json
 *
 * Every refusal is recorded word for word. These are the sentences an agent reads when a task write
 * will not run, and spec 103's whole point is that a refusal says what is missing AND that nothing
 * was attempted — a write that was refused and a write that failed halfway leave very different
 * inventories behind.
 */
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const base = (extra = {}) => ({ contract: 6, project: 'fixture', formats: [{
  id: 'fixture-pack', title: 'Fixture pack', match: ['*.pack'], modes: ['raw'], default: 'raw',
}], ...extra });
const tracker = write => base({ tracker: { provider: 'local', ...(write ? { write } : {}) } });

const ROW = { id: '7', key: 'F7', title: 'A row', labels: ['one', 'two'], criteria: ['first', 'second'] };

/* Each case names the call and its arguments. A `document` writes a declaration for the calls that
   read one; `echo` writes a tracker.write script that prints back what it was handed. */
export const CASES = [
  /* --- the write command a declaration names, and every way it can be missing ----------------- */
  ['writeCommand with no declaration', { call: 'writeCommand', declared: { declared: false } }],
  ['writeCommand on a declaration that would not read', { call: 'writeCommand', declared: { declared: true, error: '.rengine/project.json: broken' } }],
  ['writeCommand on a tracker block that would not read', { call: 'writeCommand', declared: { declared: true, trackerError: '.rengine/project.json: $.tracker is wrong' } }],
  ['writeCommand against a remote tracker', { call: 'writeCommand', declared: { declared: true, tracker: { provider: 'github', repository: 'a/b' } } }],
  ['writeCommand with no write command declared', { call: 'writeCommand', declared: { declared: true, tracker: { provider: 'local' } } }],
  ['writeCommand with nothing declared at all', { call: 'writeCommand', declared: { declared: true } }],
  ['writeCommand a project declares', { call: 'writeCommand', declared: { declared: true, tracker: { provider: 'local', write: ['tools/write.sh', '${json}'] } } }],

  /* --- the document that replaces ${json} ----------------------------------------------------- */
  ['writeDocument with an unknown action', { call: 'writeDocument', data: { action: 'delete', row: ROW } }],
  ['writeDocument with no row', { call: 'writeDocument', data: { action: 'add' } }],
  ['writeDocument with an array for a row', { call: 'writeDocument', data: { action: 'add', row: [] } }],
  ['writeDocument with an empty parent', { call: 'writeDocument', data: { action: 'add', row: ROW, parent: '' } }],
  ['writeDocument decomposing without a parent', { call: 'writeDocument', data: { action: 'decompose', row: ROW } }],
  ['writeDocument over the row limit', { call: 'writeDocument', data: { action: 'add', row: { ...ROW, pad: 'x'.repeat(64 * 1024) } } }],
  ['writeDocument for an add', { call: 'writeDocument', data: { action: 'add', row: ROW } }],
  ['writeDocument for a decompose under a parent', { call: 'writeDocument', data: { action: 'decompose', row: ROW, parent: 'F1' } }],
  /* Action last, so a row carrying its own `action` cannot rename the call. */
  ['writeDocument for a row that carries its own action', { call: 'writeDocument', data: { action: 'add', row: { ...ROW, action: 'decompose' } } }],

  /* --- the prompts ---------------------------------------------------------------------------- */
  ['renderPrompt with every placeholder', { call: 'renderPrompt', template: '${id} ${key} ${title}\n${criteria}\n${labels}', values: 'row' }],
  ['renderPrompt with one the workspace does not fill', { call: 'renderPrompt', template: 'Do ${title} for ${owner}.', values: 'row' }],
  ['renderPrompt with several it does not fill', { call: 'renderPrompt', template: '${owner} ${due} ${owner}', values: 'row' }],
  ['renderPrompt with an empty placeholder name', { call: 'renderPrompt', template: 'a ${} b', values: 'row' }],
  /* A placeholder the workspace DOES fill, handed values that do not carry it: left where it is,
     never dropped. `promptValues` always supplies all five, so this is reachable only through a
     direct caller — and a template that silently lost `${criteria}` reads exactly like one that
     never named it. */
  ['renderPrompt with a known placeholder the values do not carry', { call: 'renderPrompt', template: '${title}: ${criteria}', values: { title: 'Only the title' } }],
  ['promptValues for a full row', { call: 'promptValues', row: ROW }],
  ['promptValues for a row with nothing on it', { call: 'promptValues', row: {} }],
  ['promptValues for a row with no criteria', { call: 'promptValues', row: { ...ROW, criteria: [] } }],

  /* --- the agent and model menu ---------------------------------------------------------------- */
  ['modelArgs with no model', { call: 'modelArgs', cli: 'claude', model: '' }],
  ['modelArgs with a model that is not an identifier', { call: 'modelArgs', cli: 'claude', model: 'a model' }],
  ['modelArgs for a CLI whose recipe names no flag', { call: 'modelArgs', cli: 'gemini', model: 'some-model' }],
  ['modelArgs for a CLI whose recipe names one', { call: 'modelArgs', cli: 'claude', model: 'claude-opus-5' }],
  ['codexModels on help that names none', { call: 'helpModels', help: 'usage: codex\n  --flag  a flag\n' }],
  ['codexModels on help that lists them', { call: 'helpModels', help: '  -m, --model <MODEL>  the model\n        [possible values: gpt-6-astra, gpt-6-sol]\n' }],
  ['codexModels on help whose list wraps', { call: 'helpModels', help: '  --model <M>\n    the model to run\n    [possible values: a-one,\n b-two]\n' }],
  ['codexModels on help with names it will not take', { call: 'helpModels', help: '  --model <M> [possible values: ok-one, "not a name", ok-two]\n' }],
  ['parseInstalled on nothing', { call: 'parseInstalled', text: '' }],
  ['parseInstalled on a listing', { call: 'parseInstalled', text: 'claude\t/usr/bin/claude\ncodex\tnot installed\nkimi\t\n\n  \t/x\n' }],
  ['knownAgents from the registry', { call: 'knownAgents' }],
  ['agentsMenu a project declares', { call: 'agentsMenu', declared: { agents: [{ cli: 'claude', models: ['m-one', 'm-two'], default: 'm-one' }] },
    installed: 'claude\t/usr/bin/claude\n' }],
  ['agentsMenu with nothing declared', { call: 'agentsMenu', declared: {}, installed: 'claude\t/usr/bin/claude\ncodex\t/usr/bin/codex\n',
    help: '  --model <M> [possible values: gpt-6-astra, gpt-6-sol]\n' }],
  ['agentsMenu when the help CLI is not installed', { call: 'agentsMenu', declared: {}, installed: 'claude\t/usr/bin/claude\ncodex\tnot installed\n' }],

  /* --- the write itself ------------------------------------------------------------------------ */
  ['taskWrite through a project command that answers JSON', { call: 'taskWrite', echo: 'json', data: { action: 'add', row: ROW } }],
  ['taskWrite through a command that answers prose', { call: 'taskWrite', echo: 'prose', data: { action: 'update', row: ROW } }],
  ['taskWrite through a command that refuses', { call: 'taskWrite', echo: 'fail', data: { action: 'add', row: ROW } }],
  ['promptFor a brief the workspace ships', { call: 'promptFor', name: 'task', row: ROW }],
  ['promptFor a brief the project overrides', { call: 'promptFor', name: 'task', row: ROW, prompt: 'Project brief for ${key}: ${title}\n${criteria}' }],
  ['promptFor a brief that is not one', { call: 'promptFor', name: 'plan', row: ROW }],
  ['promptFor a project brief naming a placeholder the workspace does not fill', { call: 'promptFor', name: 'decompose', row: ROW, prompt: 'Split ${title} for ${owner}' }],
];

const SCRIPTS = {
  json: '#!/bin/bash\nprintf \'{"ok":true,"got":%s}\' "$1"\n',
  prose: '#!/bin/bash\necho "wrote $1"\n',
  fail: '#!/bin/bash\necho "the inventory is locked" >&2\nexit 3\n',
};

async function fixture(directory, name, options) {
  const root = path.join(directory, name);
  await mkdir(path.join(root, '.rengine/prompts'), { recursive: true });
  await mkdir(path.join(root, 'tools'), { recursive: true });
  if (options.echo) {
    await writeFile(path.join(root, 'tools/write.sh'), SCRIPTS[options.echo]);
    await chmod(path.join(root, 'tools/write.sh'), 0o755);
  }
  if (options.prompt) await writeFile(path.join(root, `.rengine/prompts/${options.name}.md`), options.prompt);
  return root;
}

export async function answers() {
  const tasks = await import('./tasks.mjs');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-tasks-corpus-')));
  const recorded = {};
  try {
    for (const [name, options] of CASES) {
      const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48);
      const root = { id: `root-${slug}`, path: await fixture(directory, slug, options), name: 'fixture' };
      const values = options.values === 'row' ? await tasks.promptValues(ROW) : options.values;
      const call = async () => {
        switch (options.call) {
          case 'writeCommand': return tasks.writeCommand(options.declared);
          case 'writeDocument': return tasks.writeDocument(options.data);
          case 'renderPrompt': return { text: await tasks.renderPrompt(options.template, values, 'the fixture brief') };
          case 'promptValues': return tasks.promptValues(options.row);
          case 'modelArgs': return { args: tasks.modelArgs(options.cli, options.model) };
          case 'helpModels': return { models: await tasks.helpModels(options.help) };
          case 'parseInstalled': return { installed: Object.fromEntries(await tasks.parseInstalled(options.text)) };
          case 'knownAgents': return { agents: tasks.knownAgents() };
          case 'agentsMenu': return { ...await tasks.agentsMenu(root, options.declared,
            { list: async () => options.installed ?? '', help: async () => options.help ?? '' }), rootId: '<rootId>' };
          case 'taskWrite': {
            const declared = { declared: true, tracker: { provider: 'local', write: ['tools/write.sh', '${json}'] } };
            const answer = await tasks.taskWrite(root, declared, options.data);
            return { ...answer, rootId: '<rootId>', durationMs: '<ms>' };
          }
          case 'promptFor': return tasks.promptFor(root, options.name, await tasks.promptValues(options.row));
          default: throw new Error(`unknown call ${options.call}`);
        }
      };
      try { recorded[name] = { ok: await call() }; }
      catch (error) { recorded[name] = { refused: { message: error.message, status: error.status ?? null } }; }
    }
    return recorded;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export const RECORDED = await (async () => {
  try { return JSON.parse(await readFile(new URL('./tasks-corpus.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.log(JSON.stringify(await answers(), null, 2));
}

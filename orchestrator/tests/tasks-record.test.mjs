/* F153 (spec 103, spec 129): the record `tasks.mjs` is judged against, and the harness its
 * replacement will be judged by.
 *
 * Spec 083 refused task writes outright because neither remote tracker offers concurrency control;
 * spec 103 amended that for the LOCAL backend only, and only by running the command the project
 * declared. So every refusal here is a boundary someone argued for, and the wording carries the
 * argument: an agent that reads "Nothing was attempted" knows its inventory is untouched, and one
 * that reads a command's own stderr knows it is not.
 *
 * The half that runs today replays the corpus against the live module, so the record cannot drift
 * from what it froze.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers } from './tasks-corpus.mjs';

test('the recorded task answers are the ones the module gives', { timeout: 120000 }, async () => {
  assert.ok(RECORDED, 'tasks-corpus.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  const live = await answers();
  for (const [name] of CASES) assert.deepEqual(live[name], RECORDED[name], name);
});

/* The rules the corpus exists to keep, asserted rather than left for a reader of the JSON. */
test('the corpus holds the boundaries a task write is for', () => {
  const of = name => RECORDED[name];
  /* The workspace never edits an inventory itself, and never writes a remote one. */
  assert.match(of('writeCommand against a remote tracker').refused.message, /the workspace writes only the local backend/);
  assert.equal(of('writeCommand against a remote tracker').refused.status, 409);
  assert.match(of('writeCommand with no write command declared').refused.message, /the workspace never edits the inventory itself/);
  /* Every refusal before a spawn says so, because that is the only difference a caller can act on. */
  for (const name of ['writeCommand with no declaration', 'writeCommand against a remote tracker',
    'writeCommand with no write command declared', 'writeDocument decomposing without a parent']) {
    assert.match(of(name).refused.message, /Nothing was attempted\.$/, name);
  }
  /* And a refusal that comes back FROM the command is the project's own words, not a claim about
     what did or did not happen. */
  assert.match(of('taskWrite through a command that refuses').refused.message, /^Command failed \(exit 3\): the inventory is locked$/);

  /* Action last, so a row carrying its own `action` cannot rename the call. */
  assert.equal(of('writeDocument for a row that carries its own action').ok.document.action, 'add');
  /* A decompose is a child row, and the parent sits before the action for the same reason. */
  assert.deepEqual(Object.keys(of('writeDocument for a decompose under a parent').ok.document).slice(-2), ['parent', 'action']);

  /* A prompt that misspells a placeholder is named: one quietly missing the task's criteria reads
     exactly like one that has them. */
  assert.match(of('renderPrompt with one the workspace does not fill').refused.message, /is not a placeholder the workspace fills/);
  assert.match(of('renderPrompt with several it does not fill').refused.message, /are not placeholders the workspace fills/);
  assert.equal(of('renderPrompt with several it does not fill').refused.status, 422);
  /* The list forms are rendered for the template, so a project overriding a prompt writes prose. */
  assert.equal(of('promptValues for a full row').ok.criteria, '1. first\n2. second');
  assert.match(of('promptValues for a row with no criteria').ok.criteria, /^None are recorded in the inventory/);
  assert.equal(of('promptValues for a row with nothing on it').ok.labels, 'none');

  /* A CLI whose recipe names no model flag is refused by name rather than started without the model
     the caller asked for: a spawn that silently drops the model is a pane running the wrong thing
     that looks right. */
  assert.match(of('modelArgs for a CLI whose recipe names no flag').refused.message, /will not guess a flag/);
  assert.deepEqual(of('modelArgs for a CLI whose recipe names one').ok.args, ['--model', 'claude-opus-5']);
  /* A codex that prints no choices leaves the list empty rather than inviting a guess. */
  assert.deepEqual(of('codexModels on help that names none').ok.models, []);
  assert.deepEqual(of('codexModels on help with names it will not take').ok.models, ['ok-one', 'ok-two']);

  /* A declaration wins outright; rEngine's own lists fill in only when it has not. */
  assert.equal(of('agentsMenu a project declares').ok.declared, true);
  assert.deepEqual(of('agentsMenu a project declares').ok.agents.map(a => a.cli), ['claude']);
  assert.equal(of('agentsMenu with nothing declared').ok.declared, false);
  assert.deepEqual(of('agentsMenu with nothing declared').ok.agents.find(a => a.cli === 'codex').models, ['gpt-6-astra', 'gpt-6-sol'],
    'a help-kind list is filled from the CLI itself, because its names move faster than this file');
  assert.deepEqual(of('agentsMenu when the help CLI is not installed').ok.agents.find(a => a.cli === 'codex').models, [],
    'and is not asked for when the CLI is not there');
});

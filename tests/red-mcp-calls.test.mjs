/* F185/F187 (F150b, spec 129, KI-100): red-mcp answers tool CALLS as the JS worker answered them.
 *
 * While `agents/mcp-worker.mjs` existed this ran both servers side by side and compared them. F187
 * deleted it, so the JS half is now the record it left behind — `mcp-conversation.json`, captured
 * from that worker at the commit before its deletion and never regenerated. Replaying the
 * conversation against red-mcp and calling the result parity would be red-mcp agreeing with
 * itself; the same discipline F148, F172, F178 and F184 all arrived at.
 *
 * The conversation is 56 calls covering all 38 tools, run against a real workspace with a live
 * session and, halfway through, another agent holding the token — because that is the only way the
 * identity headers change an answer. Most of it is refusals, deliberately: an agent meets "this
 * workspace predates …" far more often than a happy path.
 *
 * Only per-workspace values are normalised (uuids, hashes, timestamps, ports, epochs, pids,
 * durations, contest seconds, the workspace directory, a conversation's eight-character prefix).
 * Everything that carries meaning is compared, including `content[0].text` — the answer
 * stringified, so key order is part of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { identity, ok } from './token-fixtures.mjs';
import { BINARY, CALLS, REPO, converse, normalise, workspace } from './mcp-conversation.mjs';
import { built } from './cargo.mjs';

const run = promisify(execFile);

test('red-mcp answers every tool call the way the JS worker answered it', { timeout: 600000 }, async t => {
  await built('-p', 'red-mcp', '--bin', 'red-mcp');
  assert.ok(existsSync(BINARY), `red-mcp was built at ${BINARY}`);
  const recorded = JSON.parse(await readFile(path.join(REPO, 'tests/mcp-conversation.json'), 'utf8')).calls;
  assert.deepEqual(recorded.map(entry => entry.name), CALLS.map(([name]) => name),
    'every call in the conversation has an answer from the module that is gone, and no call was added without one');

  const rust = await workspace(t, 'rust');
  const other = { ...identity('the-other-agent'), agentId: '11111111-2222-3333-4444-555555555555' };
  const claim = async () => { await ok(rust.worker, 'token-action', { rootId: rust.root.id, action: 'contest', reason: 'the other agent takes it' }, other); };
  const answers = await converse(t, BINARY, ['--context', rust.contextFile], rust.session.id, claim);

  const differences = [];
  for (const [index, [name]] of CALLS.entries()) {
    const expected = recorded[index].answer;
    const actual = normalise(answers[index], rust.directory);
    try { assert.deepEqual(actual, expected); }
    catch { differences.push({ name, expected, actual }); }
  }
  assert.deepEqual(differences.map(d => d.name), [],
    `every call answers what the worker answered:\n${differences.map(d => `${d.name}\n  was:  ${JSON.stringify(d.expected).slice(0, 400)}\n  now:  ${JSON.stringify(d.actual).slice(0, 400)}`).join('\n')}`);

  const refused = recorded.filter(entry => entry.answer?.isError).length;
  assert.ok(refused > 10, `the conversation exercises the refusals: ${refused} of ${CALLS.length}`);
  assert.ok(CALLS.length - refused > 8, `and the answers: ${CALLS.length - refused} of ${CALLS.length}`);
});

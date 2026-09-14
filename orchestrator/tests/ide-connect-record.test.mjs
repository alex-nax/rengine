/* F161 (F103, spec 133): the record editor discovery is judged against.
 *
 * Whether a pane's CLI is told to connect, and to which editor, was measured on 2026-09-07 rather
 * than read out of the CLI's source: four locks covered one folder and `/ide` offered all four. So
 * the rule is the one the CLI applies — folders against cwd, a live pid — plus this workspace's own
 * editor named by port. This replays the corpus against the live module, then reads the rules back
 * out of the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, answers, jsHarness } from './ide-connect-corpus.mjs';

test('the recorded discovery answers are the ones ide-connect.mjs gives', { timeout: 120000 }, async () => {
  assert.ok(RECORDED, 'ide-connect-corpus.json is present; it is the evidence, not a cache');
  assert.equal(Object.keys(RECORDED).length, CASES.length, 'every case has a recorded answer');
  const live = await answers(await jsHarness());
  for (const [name] of CASES) assert.deepEqual(live[name], RECORDED[name], name);
});

test('the corpus holds the rules discovery is for', () => {
  const of = name => RECORDED[name];
  const ports = (name, index) => of(name)[index].editors.map(editor => editor.port);

  /* Containment is a path boundary, in both directions: `/work/rengine-old` is not inside
     `/work/rengine`, and querying from the sibling is the direction a bare prefix gets wrong. */
  assert.deepEqual(ports('a folder covers the directory, and a lookalike does not', 0), [100]);
  assert.deepEqual(ports('a folder covers the directory, and a lookalike does not', 1), [200], 'the sibling is offered its own editor only');
  assert.deepEqual(ports('a folder covers the directory, and a lookalike does not', 2), [100], 'the folder itself is inside');
  assert.deepEqual(ports('a folder covers the directory, and a lookalike does not', 3), [], 'the parent is not');
  assert.deepEqual(ports('a folder covers the directory, and a lookalike does not', 5), [100], 'a directory is resolved before it is compared');
  assert.deepEqual(ports('a folder with a trailing slash still covers', 1), [100]);

  /* NFC on both sides, because a macOS path can arrive decomposed. */
  const nfc = of('paths are compared in NFC, because a macOS path can arrive decomposed');
  assert.deepEqual(nfc.map(entry => entry.editors.map(editor => editor.port)), [[100], [100], [200], [200]]);

  /* Liveness: a dead pid is not offered; one that cannot be signalled is; a pid that is not an
     integer is not a pid. */
  assert.deepEqual(ports('liveness: which pids a lock may name', 0), [100, 300, 400]);

  /* The shape: folders must be an array with a covering string in it; the port is the filename. */
  const shape = of('the shape of a lock, and what is skipped')[0].editors;
  assert.deepEqual(shape.map(editor => editor.port), [-3, 7, 12.5, 100, 300, 700, 800, 900, null]);
  assert.deepEqual(shape.find(editor => editor.port === 700), { port: 700, pid: '<self>', ours: false }, 'no name is no name, not a string');
  assert.deepEqual(shape.find(editor => editor.port === 900).ours, false);
  assert.deepEqual(of('a lock directory that is not there')[0].editors, []);

  /* The decision: ours by pid, named by port, so a machine-mate's editor does not block a pane. */
  const own = of('this workspace\'s own editor is named by port, so a machine-mate\'s does not block it').map(entry => entry.decision);
  assert.deepEqual(own[0], { flags: ['--ide'], env: { CLAUDE_CODE_SSE_PORT: '200' }, offered: 2, reason: "2 editors are published for this directory; connecting to this workspace's own on port 200." });
  assert.deepEqual(own[2], { flags: [], env: {}, offered: 2, reason: "2 editors are published for this directory and none of them is this workspace's, so there is nothing to choose; run /ide." });
  assert.deepEqual(own[3], { flags: [], env: {}, offered: 2, reason: "2 editors are published for this directory and this workspace could not be identified among them, so there is nothing to choose; run /ide." });
  assert.equal(own[5].env.CLAUDE_CODE_SSE_PORT, '200', 'non-integers among our pids are ignored, not fatal');
  assert.deepEqual(own[6].flags, [], 'a pid as a string is not a pid');
  assert.deepEqual(of('a pid of ours whose lock is another editor\'s is not ours')[0].decision.flags, [], "our pid under another editor's name is not our editor");

  /* Exactly one, when this workspace cannot be identified. */
  const one = of('exactly one is the rule when this workspace cannot be identified').map(entry => entry.decision);
  assert.deepEqual(one[0], { flags: ['--ide'], env: {}, offered: 1, reason: 'One <product> is published for this directory; connecting on startup.' });
  assert.deepEqual(one[1], { flags: ['--ide'], env: { CLAUDE_CODE_SSE_PORT: '100' }, offered: 1, reason: "This workspace's <product> is published for this directory; connecting on startup." });
  assert.deepEqual(one[3], { flags: [], env: {}, reason: 'No editor is published for this directory, so auto-connect would fail at startup.' });
  assert.deepEqual(of('the one editor published is not ours to connect to')[0].decision, { flags: [], env: {}, reason: 'The one editor published here is VS Code, not <product>; it is not ours to connect to.' });
  assert.match(of('the one editor published has no name at all')[0].decision.reason, /published here is undefined, not <product>/);

  /* A CLI whose recipe names no option launches exactly as it does today. */
  for (const entry of of('a CLI with no auto-connect option is left alone, whatever is published')) {
    assert.deepEqual(entry.decision.flags, []);
    assert.equal(entry.decision.reason, `${entry.connect[0]} has no auto-connect option; nothing was added to its command line.`);
  }
});

/* F153 (spec 129): the Rust task module answers the recorded corpus.
 *
 * `tasks-record.test.mjs` is the other half — it proves the record is what the JavaScript says.
 * This one proves the replacement says the same thing, including every refusal word for word: an
 * agent that reads "Nothing was attempted" knows its inventory is untouched, and that sentence is
 * the whole difference between a write that was refused and one that failed halfway.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, RECORDED } from './tasks-corpus.mjs';
import { built } from './cargo.mjs';

const BINARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../red/target/debug/red-project');
const ROW = { id: '7', key: 'F7', title: 'A row', labels: ['one', 'two'], criteria: ['first', 'second'] };
/* What `promptValues(ROW)` renders, written out rather than imported: this harness judges the Rust,
   and asking the module under replacement to prepare its input would be asking the Rust twice. */
const ROW_VALUES = { id: '7', key: 'F7', title: 'A row', labels: 'one, two', criteria: '1. first\n2. second' };
const SCRIPTS = {
  json: '#!/bin/bash\nprintf \'{"ok":true,"got":%s}\' "$1"\n',
  prose: '#!/bin/bash\necho "wrote $1"\n',
  fail: '#!/bin/bash\necho "the inventory is locked" >&2\nexit 3\n',
};

function ask(call, rootId, rootPath, input) {
  return new Promise(resolve => {
    const child = execFile(BINARY, ['tasks', call, rootId, rootPath], { maxBuffer: 1 << 26 }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { resolve({ refused: { message: `red-project answered nothing: ${stdout}`, status: null } }); return; }
      resolve(value?.error !== undefined && value?.status !== undefined ? { refused: { message: value.error, status: value.status } } : { ok: value });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test('the Rust task module gives the recorded answers', { timeout: 300000 }, async t => {
  await built('-p', 'red-project', '--bin', 'red-project');
  assert.ok(RECORDED, 'tasks-corpus.json is present');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-tasks-parity-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const drift = [];
  for (const [name, options] of CASES) {
    const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48);
    const root = path.join(directory, slug);
    await mkdir(path.join(root, '.rengine/prompts'), { recursive: true });
    await mkdir(path.join(root, 'tools'), { recursive: true });
    if (options.echo) { await writeFile(path.join(root, 'tools/write.sh'), SCRIPTS[options.echo]); await chmod(path.join(root, 'tools/write.sh'), 0o755); }
    if (options.prompt) await writeFile(path.join(root, `.rengine/prompts/${options.name}.md`), options.prompt);
    const rootId = `root-${slug}`;
    const values = options.values === 'row' ? ROW_VALUES : options.values;
    const input = {
      declared: options.declared ?? (options.call === 'taskWrite' ? { declared: true, tracker: { provider: 'local', write: ['tools/write.sh', '${json}'] } } : undefined),
      data: options.data, template: options.template, values: options.call === 'promptFor' ? ROW_VALUES : values,
      source: 'the fixture brief', row: options.row, cli: options.cli, model: options.model, help: options.help ?? '',
      text: options.text, installed: options.installed ?? '', name: options.name,
    };
    let live = await ask(options.call, rootId, root, input);
    /* The menu is two halves, exactly as the client asks it: what it can build now, and the CLIs
       whose own `--help` it still wants. A declared menu wants none, and that is the assertion the
       JavaScript made by throwing from its `help`. */
    if (options.call === 'agentsMenu' && live.ok) {
      const wanted = live.ok.needsHelp ?? [];
      if (wanted.length) {
        live = await ask(options.call, rootId, root, { ...input, help: Object.fromEntries(wanted.map(cli => [cli, options.help ?? ''])) });
      }
      live = { ok: { ...live.ok.menu, rootId: '<rootId>' } };
    }
    /* The same two fields the record folds: a root id that is a path, and a duration. */
    if (live.ok?.rootId !== undefined) live = { ok: { ...live.ok, rootId: '<rootId>' } };
    if (live.ok?.durationMs !== undefined) live = { ok: { ...live.ok, durationMs: '<ms>' } };
    /* `writeDocument` answers the document and the json it becomes; the record kept both. */
    if (options.call === 'writeDocument' && live.ok) live = { ok: { document: live.ok.document, json: live.ok.json } };
    if (JSON.stringify(live) !== JSON.stringify(RECORDED[name])) drift.push([name, live]);
  }
  for (const [name, live] of drift) assert.deepEqual(live, RECORDED[name], name);
  assert.deepEqual(drift.map(([name]) => name), [], 'every case answers as recorded');
});

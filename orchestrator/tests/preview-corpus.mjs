/* The answers `formats.mjs`'s preview and byte-window give, recorded before they are replaced
 * (F156, spec 129).
 *
 * These are the last two things that module does: run a command the project declared over one of
 * its files, and hand back a window of raw bytes. Everything else in it moved with the declaration
 * reader. What is recorded is the ANSWER, including every refusal word for word — a preview that
 * will not run is what a person sees instead of their file, and the sentence is the whole
 * explanation.
 *
 *   node orchestrator/tests/preview-corpus.mjs > orchestrator/tests/preview-corpus.json
 *
 * Regenerate ONLY from a checkout where `formats.mjs` still runs them. Three things are folded
 * because they are a machine's rather than a rule's: the project path inside a resolved command,
 * how long a command took, and a file's modification time.
 */
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* Constant commands, so the record is the same on any machine: `/bin/cat` prints the file it is
   given and `/bin/echo` prints its arguments, which is all a preview has to do to be tested. */
const TEXT = { id: 'text-format', title: 'Text format', match: ['*.txt'], modes: ['preview'], default: 'preview',
  preview: { kind: 'text', command: ['/bin/cat', '${file}'], timeoutMs: 4000, maxBytes: 4194304 } };
const TREE = { id: 'tree-format', title: 'Tree format', match: ['*.tree'], modes: ['preview'], default: 'preview',
  preview: { kind: 'tree', command: ['/bin/cat', '${file}'], timeoutMs: 4000, maxBytes: 65536 } };
const ENTRY = { id: 'entry-format', title: 'Entry format', match: ['*.pack'], modes: ['raw', 'preview'], default: 'raw',
  preview: { kind: 'text', command: ['/bin/cat', '${file}'], timeoutMs: 4000, maxBytes: 65536 },
    /* The project's own script again, and one that prints only the ENTRY: `/bin/echo` would print
     the resolved file path, whose length and bytes are a temporary directory's — so the size and
     the sha256 of the answer would be this run's rather than this rule's. */
  entry: { kind: 'bytes', command: ['tools/entry.sh', '${file}', '${entry}'], timeoutMs: 4000, maxBytes: 65536 } };
const BARE = { id: 'bare-format', title: 'Bare format', match: ['*.bare'], modes: ['raw'], default: 'raw' };
const FAILING = { id: 'failing-format', title: 'Failing format', match: ['*.bad'], modes: ['preview'], default: 'preview',
  /* The project's own script, so the record does not depend on which machine has which `false`:
     it names ${file}, as the rules require, and exits non-zero saying why. */
  preview: { kind: 'text', command: ['tools/fail.sh', '${file}'], timeoutMs: 4000, maxBytes: 65536 } };

const base = (formats) => ({ contract: 1, project: 'fixture', formats });
const ALL = [TEXT, TREE, ENTRY, BARE, FAILING];
const tree = { name: 'root', dirs: [{ name: 'sub', dirs: [], files: [{ name: 'b.dat', path: 'sub/b.dat', size: 3 }] }],
  files: [{ name: 'a.dat', path: 'a.dat', size: 7 }] };

export const CASES = [
  ['a project that declares nothing', { document: null, call: 'preview', data: { path: 'a.txt' } }],
  ['a declaration that would not read', { document: '{ not json', call: 'preview', data: { path: 'a.txt' } }],
  ['a preview of a directory', { call: 'preview', data: { path: 'sub' } }],
  ['a preview of a file no format matches', { call: 'preview', data: { path: 'nothing.md' } }],
  ['a preview naming a formatId this project has not', { call: 'preview', data: { path: 'a.txt', formatId: 'no-such-format' } }],
  ['a preview of a format that declares none', { call: 'preview', data: { path: 'a.bare' } }],
  ['a text preview', { call: 'preview', data: { path: 'a.txt' } }],
  ['a text preview whose command fails', { call: 'preview', data: { path: 'a.bad' } }],
  ['a text preview that is not UTF-8', { call: 'preview', data: { path: 'binary.txt' } }],
  ['a tree preview', { call: 'preview', data: { path: 'a.tree' } }],
  ['a tree preview whose output is not JSON', { call: 'preview', data: { path: 'bad.tree' } }],
  ['a tree preview whose node is the wrong shape', { call: 'preview', data: { path: 'wrong.tree' } }],
  ['an entry', { call: 'preview', data: { path: 'a.pack', entry: 'readme.txt' } }],
  ['an entry that is not a bounded string', { call: 'preview', data: { path: 'a.pack', entry: '' } }],
  ['an entry on a format that declares none', { call: 'preview', data: { path: 'a.txt', entry: 'readme.txt' } }],
  ['an entry with a byte window', { call: 'preview', data: { path: 'a.pack', entry: 'readme.txt', offset: 2, length: 4 } }],
  ['an entry whose byte window has a negative offset', { call: 'preview', data: { path: 'a.pack', entry: 'readme.txt', offset: -1 } }],

  ['a byte window', { call: 'bytes', data: { path: 'a.txt' } }],
  ['a byte window with an offset and a length', { call: 'bytes', data: { path: 'a.txt', offset: 3, length: 5 } }],
  ['a byte window past the end of the file', { call: 'bytes', data: { path: 'a.txt', offset: 9000, length: 16 } }],
  ['a byte window with a negative offset', { call: 'bytes', data: { path: 'a.txt', offset: -1 } }],
  ['a byte window of a directory', { call: 'bytes', data: { path: 'sub' } }],
  ['a byte window of a file that is not there', { call: 'bytes', data: { path: 'missing.txt' } }],
  ['a byte window that leaves the project', { call: 'bytes', data: { path: '../escape.txt' } }],

  /* The shapes a ROUTE actually delivers, which the first pass of this record had no case for.
     `/api/bytes` is a query string, so its offset and length arrive as TEXT and go through
     `Number()` — where an empty one is 0 and an exponent is a number. `/api/format-preview` is a
     JSON body, so the entry window's are numbers, and a bad one refuses rather than falling back to
     zero. Added while the JavaScript that answers them still existed, which is the only time a
     record can be extended; what a route cannot deliver — a boolean, an array — is not recorded,
     and `Number()`'s answers for those are not a rule this project relies on. */
  ['a byte window whose offset and length arrived as text', { call: 'bytes', data: { path: 'a.txt', offset: '3', length: '5' } }],
  ['a byte window whose offset arrived empty', { call: 'bytes', data: { path: 'a.txt', offset: '', length: '4' } }],
  ['a byte window whose offset is not a number', { call: 'bytes', data: { path: 'a.txt', offset: 'x' } }],
  ['a byte window whose offset is fractional', { call: 'bytes', data: { path: 'a.txt', offset: 1.5 } }],
  ['a byte window whose length is written in exponent form', { call: 'bytes', data: { path: 'a.txt', length: '1e1' } }],
];

/** The project a case is asked about, and the folding, shared with the harness that judges the
    replacement — a second copy of either is a second thing that can drift. */
export async function fixtureFor(directory, name, options) {
  return fixture(directory, name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48), options);
}
export const foldFor = (value, root) => fold(value, root);

async function fixture(directory, name, options) {
  const root = path.join(directory, name);
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await mkdir(path.join(root, 'tools'), { recursive: true });
  await writeFile(path.join(root, 'tools/fail.sh'), '#!/bin/bash\necho "the producer could not read it" >&2\nexit 4\n');
  await chmod(path.join(root, 'tools/fail.sh'), 0o755);
  await writeFile(path.join(root, 'tools/entry.sh'), '#!/bin/bash\nprintf "%s" "$2"\n');
  await chmod(path.join(root, 'tools/entry.sh'), 0o755);
  if (options.document === null) { /* no declaration at all */ }
  else if (typeof options.document === 'string') await writeFile(path.join(root, '.rengine/project.json'), options.document);
  else await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(base(ALL)));
  await writeFile(path.join(root, 'a.txt'), 'one two three\n');
  await writeFile(path.join(root, 'nothing.md'), '# nothing\n');
  await writeFile(path.join(root, 'a.bare'), 'bare\n');
  await writeFile(path.join(root, 'a.bad'), 'bad\n');
  await writeFile(path.join(root, 'binary.txt'), Buffer.from([0x41, 0x00, 0xff, 0xfe]));
  await writeFile(path.join(root, 'a.tree'), JSON.stringify(tree));
  await writeFile(path.join(root, 'bad.tree'), 'not json at all');
  await writeFile(path.join(root, 'wrong.tree'), JSON.stringify({ name: 'root', dirs: [], files: [{ name: 'a', path: 'a', size: -1 }] }));
  await writeFile(path.join(root, 'a.pack'), 'pack bytes\n');
  return root;
}

/* A resolved command names the project it ran in, a run says how long it took, and a file says when
   it changed. None of the three is a rule. */
const fold = (value, root) => JSON.parse(JSON.stringify(value, (key, item) => {
  if (key === 'durationMs') return '<ms>';
  if (key === 'modified') return '<mtime>';
  return typeof item === 'string' ? item.split(root).join('<root>') : item;
}));

export async function answers() {
  const { formatPreview, readBytes } = await import('../server/formats.mjs');
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'rengine-preview-corpus-')));
  await writeFile(path.join(directory, 'escape.txt'), 'outside\n');
  const recorded = {};
  try {
    for (const [name, options] of CASES) {
      const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 48);
      const root = { id: `root-${slug}`, path: await fixture(directory, slug, options), name: 'fixture' };
      try {
        const answer = options.call === 'preview' ? await formatPreview(root, options.data) : await readBytes(root, options.data);
        recorded[name] = { ok: fold({ ...answer, rootId: answer.rootId === undefined ? undefined : '<rootId>' }, root.path) };
      } catch (error) {
        recorded[name] = { refused: { message: error.message.split(root.path).join('<root>'), status: error.status ?? null } };
      }
    }
    return recorded;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export const RECORDED = await (async () => {
  try { return JSON.parse(await readFile(new URL('./preview-corpus.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.log(JSON.stringify(await answers(), null, 2));
}

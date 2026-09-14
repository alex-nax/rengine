/* The answers `formats.mjs`'s `readDeclaration` gives, recorded before it is replaced (F156b, spec
 * 129, KI-107).
 *
 * The device F148/F172/F178 established: a replacement cannot be compared against a module that no
 * longer exists, so the module's own answers are recorded while it is still here and the Rust side
 * is judged against the record afterwards. Regenerate ONLY from a checkout where `formats.mjs`
 * still reads declarations — that is, never again after the deletion commit; the file is the
 * evidence, and a regenerated one would be judging the replacement against itself.
 *
 *   node orchestrator/tests/declaration-fixtures.mjs > orchestrator/tests/declaration-fixtures.json
 *
 * What is recorded is the ANSWER, including its refusals word for word: `readDeclaration` reports a
 * bad declaration rather than throwing, and those sentences are what a person reads in the chrome
 * when their project will not load. Absolute paths are folded to `<root>` and `<elsewhere>` so the
 * record is the same on any machine — those two are the only machine-dependent things in it.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { game, second } from './game-fixtures.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
/* The corpus declares its own format rather than borrowing `format-fixtures`', because that one
   names this machine's node and this checkout's producer — and a record that carried either would
   be a record only this machine could check. Every path here is a constant. */
const FORMAT = {
  id: 'fixture-pack', title: 'Fixture pack', match: ['*.pack'], modes: ['raw', 'preview'], default: 'raw',
  preview: { kind: 'tree', command: ['/bin/cat', '${file}'], timeoutMs: 4000, maxBytes: 65536 },
  entry: { kind: 'bytes', command: ['/bin/cat', '${file}', '${entry}'], timeoutMs: 4000, maxBytes: 65536 },
};
const base = (extra = {}) => ({ contract: 1, project: 'fixture', formats: [FORMAT], ...extra });
const DASHBOARD = { title: 'Fixture', groups: [{ id: 'build', title: 'Build', actions: [
  { id: 'check', title: 'Check', command: ['/bin/echo', 'checked'] }] }] };

/* Each case is a declaration and the files beside it, if any. A `document` of `null` writes no
   declaration at all; a string is written verbatim, so a case can be invalid JSON. */
export const CASES = [
  ['no declaration at all', { document: null }],
  ['a declaration that is not JSON', { document: '{ not json' }],
  ['a declaration that is not an object', { document: '[]' }],
  ['a declaration above the 256 KiB limit', { document: JSON.stringify({ ...base(), pad: 'x'.repeat(256 * 1024) }) }],
  ['an unknown contract', { document: { ...base(), contract: 99 } }],
  ['a contract that is not a number', { document: { ...base(), contract: '1' } }],
  ['a document the schema refuses', { document: { contract: 1, project: 'fixture' } }],
  ['a document with several schema problems', { document: { contract: 1, project: 7, formats: 'no' } }],
  ['the minimal contract-1 declaration', { document: base() }],

  ['a title below its contract floor', { document: { ...base(), contract: 4, title: 'Fixture' } }],
  ['a title on contract 5', { document: { ...base(), contract: 5, title: 'Fixture' } }],
  ['an icon below its contract floor', { document: { ...base(), contract: 4, icon: { glyph: 'F' } } }],
  ['an icon token that is not a design token', { document: { ...base(), contract: 5, icon: { glyph: 'F', token: 'purple' } } }],
  ['an icon token that is', { document: { ...base(), contract: 5, icon: { glyph: 'F', token: 'accent' } } }],
  ['an icon carrying both a glyph and an image', { document: { ...base(), contract: 8, icon: { glyph: 'F', image: 'mark.svg' } }, files: { 'mark.svg': SVG } }],
  ['an icon carrying neither', { document: { ...base(), contract: 8, icon: { token: 'accent' } } }],
  ['agents below their contract floor', { document: { ...base(), contract: 5, agents: [{ cli: 'claude', models: ['m'], default: 'm' }] } }],
  ['agents on contract 6', { document: { ...base(), contract: 6, agents: [{ cli: 'claude', models: ['claude-opus-5'], default: 'claude-opus-5' }] } }],

  ['brand artwork below its contract floor', { document: { ...base(), contract: 7, icon: { image: 'mark.svg' } }, files: { 'mark.svg': SVG } }],
  ['an icon image outside the declaration\'s directory', { document: { ...base(), contract: 8, icon: { image: '../mark.svg' } } }],
  ['an icon image that is not an svg', { document: { ...base(), contract: 8, icon: { image: 'mark.png' } }, files: { 'mark.png': 'x' } }],
  ['an icon image that cannot be read', { document: { ...base(), contract: 8, icon: { image: 'missing.svg' } } }],
  ['an icon image that can', { document: { ...base(), contract: 8, icon: { image: 'mark.svg' } }, files: { 'mark.svg': SVG } }],
  ['a wordmark named once for both themes', { document: { ...base(), contract: 8, wordmark: 'word.svg' }, files: { 'word.svg': SVG } }],
  ['a wordmark named per theme', { document: { ...base(), contract: 8, wordmark: { light: 'light.svg', dark: 'dark.svg' } }, files: { 'light.svg': SVG, 'dark.svg': SVG } }],
  ['a wordmark whose dark half is missing', { document: { ...base(), contract: 8, wordmark: { light: 'light.svg', dark: 'dark.svg' } }, files: { 'light.svg': SVG } }],

  ['a local tracker', { document: { ...base(), contract: 5, tracker: { provider: 'local', inventory: 'features.json' } } }],
  ['a github tracker with no repository', { document: { ...base(), contract: 5, tracker: { provider: 'github' } } }],
  ['a github tracker wearing linear\'s filters', { document: { ...base(), contract: 5, tracker: { provider: 'github', repository: 'owner/repo', project: 'p' } } }],
  ['a linear tracker', { document: { ...base(), contract: 5, tracker: { provider: 'linear', team: 'KOH' } } }],

  ['games and a dashboard together', { document: { ...base(), contract: 3, games: [game(), second()], dashboard: DASHBOARD } }],
  ['a dashboard on contract 2', { document: { ...base(), contract: 2, dashboard: DASHBOARD } }],
  ['two language servers with one id', { document: { ...base(), contract: 9, languageServers: [
    { id: 'ls', command: ['/bin/cat'], match: ['*.rs'] }, { id: 'ls', command: ['/bin/cat'], match: ['*.c'] }] } }],
  ['one language server', { document: { ...base(), contract: 9, languageServers: [
    { id: 'ls', command: ['/bin/cat'], match: ['*.rs'] }] } }],
  ['a pack with a library facet', { document: { ...base(), contract: 9, packs: [
    { name: 'fixture', pin: { version: '1.0.0', revision: 'a'.repeat(40) }, library: { path: 'lib', target: 'fixture' } }] } }],
  ['a pack with neither facet', { document: { ...base(), contract: 9, packs: [
    { name: 'fixture', pin: { version: '1.0.0', revision: 'a'.repeat(40) } }] } }],
  ['a tests manifest that is not root-relative', { document: { ...base(), contract: 10, tests: { manifest: '/etc/manifest.json' } } }],
  ['a tests manifest that is', { document: { ...base(), contract: 10, tests: { manifest: '.cache/tests.json' } } }],
];

/* One project per case, read the way a workspace reads it. */
async function answers() {
  const { readDeclaration } = await import('../server/formats.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-declaration-record-'));
  const recorded = {};
  try {
    for (const [name, { document, files = {} }] of CASES) {
      const root = path.join(directory, name.replaceAll(/[^a-z0-9]+/gi, '-'));
      await mkdir(path.join(root, '.rengine'), { recursive: true });
      for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
      if (document !== null) {
        await writeFile(path.join(root, '.rengine/project.json'),
          typeof document === 'string' ? document : JSON.stringify(document));
      }
      const read = await readDeclaration({ id: 'fixture-root', path: root, name: 'fixture' });
      recorded[name] = JSON.parse(JSON.stringify(read).replaceAll(root, '<root>').replaceAll(directory, '<elsewhere>'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  return recorded;
}

export const RECORDED = await (async () => {
  try { return JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./declaration-fixtures.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.log(JSON.stringify(await answers(), null, 2));
}
export { answers };

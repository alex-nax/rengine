/* The answers `agents/ide-connect.mjs` gave, recorded before it was replaced (F161, F103, spec 133).
 *
 * Which published editors a pane's directory is inside, and whether its CLI is told to connect:
 * the rule the CLI was MEASURED to apply (folders against cwd, a live pid) plus the one thing that
 * makes it usable on a machine where two workspaces bind one folder — naming this workspace's own
 * editor by port. Every sentence a pane prints at startup is here, word for word.
 *
 * `ide-connect-corpus.json` was taken at 77595e5, while `ide-connect.mjs` still decided, and is
 * FROZEN: the generator was deleted with the implementation it asked, so the record cannot be
 * regenerated against its own replacement. `ide-connect-parity.test.mjs` asks the binary the same
 * questions through `answers()` and compares. Folded: the two live pids this process can vouch
 * for (its own and its parent's), and the product's name. The pid that answers EPERM is 1 on every
 * unix and is recorded as itself.
 */
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRODUCT_NAME } from './product.mjs';

export const DEAD = 2147483647;
export const LIVE = process.pid;
export const PARENT = process.ppid;

const ours = (folders, pid = LIVE) => ({ pid, ideName: PRODUCT_NAME, workspaceFolders: folders });

/* Each case writes the locks it names, then asks. `offered` records the editors for a directory;
   `connect` records the whole launch decision. Both may run several times on one directory. */
export const CASES = [
  ['a folder covers the directory, and a lookalike does not', { locks: {
    100: ours(['/work/rengine']), 200: ours(['/work/rengine-old']), 300: ours(['/elsewhere']),
  }, asks: [
    { offered: '/work/rengine/orchestrator' },
    { offered: '/work/rengine-old' },
    { offered: '/work/rengine' },
    { offered: '/work' },
    { offered: '/work/rengine/' },
    { offered: '/work/./rengine/../rengine/x' },
  ] }],
  ['a folder with a trailing slash still covers', { locks: { 100: ours(['/work/rengine/']) }, asks: [
    { offered: '/work/rengine' }, { offered: '/work/rengine/sub' },
  ] }],
  ['paths are compared in NFC, because a macOS path can arrive decomposed', { locks: {
    100: ours(['/work/café']), 200: ours(['/work/näive']),
  }, asks: [
    { offered: '/work/café/src' }, { offered: '/work/café/src' },
    { offered: '/work/näive' }, { offered: '/work/näive' },
  ] }],
  ['liveness: which pids a lock may name', { locks: {
    100: ours(['/work'], LIVE), 200: ours(['/work'], DEAD), 300: ours(['/work'], 1), 400: ours(['/work'], 0),
    500: ours(['/work'], String(LIVE)), 600: ours(['/work'], 12.5), 700: { ideName: PRODUCT_NAME, workspaceFolders: ['/work'] },
    800: ours(['/work'], true), 900: ours(['/work'], null),
  }, asks: [{ offered: '/work' }] }],
  ['the shape of a lock, and what is skipped', { locks: {
    100: { pid: LIVE, ideName: PRODUCT_NAME },
    200: { pid: LIVE, ideName: PRODUCT_NAME, workspaceFolders: '/work' },
    300: { pid: LIVE, ideName: PRODUCT_NAME, workspaceFolders: [5, null, '/work'] },
    400: { pid: LIVE, ideName: PRODUCT_NAME, workspaceFolders: [5, '/elsewhere'] },
    500: 'not json',
    '600.txt': ours(['/work']),
    abc: ours(['/work']),
    '12.5': ours(['/work']),
    '007': ours(['/work']),
    '1e2': ours(['/work']),
    '-3': ours(['/work']),
    700: { pid: LIVE, workspaceFolders: ['/work'] },
    800: { pid: LIVE, ideName: 5, workspaceFolders: ['/work'] },
    900: { pid: LIVE, ideName: 'VS Code', workspaceFolders: ['/work'] },
    1000: [],
    1100: null,
    1200: 'null',
  }, asks: [{ offered: '/work' }] }],
  ['a lock directory that is not there', { locks: null, asks: [{ offered: '/work' }, { connect: ['claude', '/work', { ourPids: [] }] }] }],
  ['this workspace\'s own editor is named by port, so a machine-mate\'s does not block it', { locks: {
    100: ours(['/work'], LIVE), 200: ours(['/work'], PARENT),
  }, asks: [
    { connect: ['claude', '/work', { ourPids: [PARENT, 77] }] },
    { connect: ['claude', '/work', { ourPids: [LIVE] }] },
    { connect: ['claude', '/work', { ourPids: [999] }] },
    { connect: ['claude', '/work', { ourPids: [] }] },
    { connect: ['claude', '/work', {}] },
    { connect: ['claude', '/work', { ourPids: ['1', 1.5, null, PARENT] }] },
    { connect: ['claude', '/work', { ourPids: [String(PARENT)] }] },
  ] }],
  ['a pid of ours whose lock is another editor\'s is not ours', { locks: {
    100: ours(['/work'], LIVE), 200: { pid: PARENT, ideName: 'VS Code', workspaceFolders: ['/work'] },
  }, asks: [
    { connect: ['claude', '/work', { ourPids: [PARENT] }] },
    { connect: ['claude', '/work', { ourPids: [LIVE] }] },
  ] }],
  ['exactly one is the rule when this workspace cannot be identified', { locks: { 100: ours(['/work']) }, asks: [
    { connect: ['claude', '/work', {}] },
    { connect: ['claude', '/work', { ourPids: [LIVE] }] },
    { connect: ['claude', '/work', { ourPids: [999] }] },
    { connect: ['claude', '/elsewhere', {}] },
  ] }],
  ['the one editor published is not ours to connect to', { locks: {
    100: { pid: LIVE, ideName: 'VS Code', workspaceFolders: ['/work'] },
  }, asks: [{ connect: ['claude', '/work', {}] }, { connect: ['claude', '/work', { ourPids: [LIVE] }] }] }],
  ['the one editor published has no name at all', { locks: {
    100: { pid: LIVE, workspaceFolders: ['/work'] },
  }, asks: [{ connect: ['claude', '/work', {}] }] }],
  ['nothing is published for the directory', { locks: { 100: ours(['/elsewhere']) }, asks: [
    { connect: ['claude', '/work', {}] },
  ] }],
  ['a CLI with no auto-connect option is left alone, whatever is published', { locks: { 100: ours(['/work']) }, asks: [
    { connect: ['codex', '/work', {}] }, { connect: ['gemini', '/work', {}] }, { connect: ['opencode', '/work', {}] },
    { connect: ['kimi', '/work', {}] }, { connect: ['nonexistent', '/work', {}] },
  ] }],
];

const foldPid = value => value === LIVE ? '<self>' : value === PARENT ? '<parent>' : value === String(PARENT) ? '<parent as a string>' : value;
const foldText = text => typeof text === 'string'
  ? text.split(PRODUCT_NAME).join('<product>').replace(new RegExp(`(?<![0-9])${LIVE}(?![0-9])`, 'g'), '<self>').replace(new RegExp(`(?<![0-9])${PARENT}(?![0-9])`, 'g'), '<parent>')
  : text;
export const fold = value => {
  if (Array.isArray(value)) return value.map(fold);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'pid' ? foldPid(v) : fold(v)]));
  return foldText(value);
};

/* Which environment-dependent inputs a case names, so the record reads the same on any machine. */
export const foldInputs = options => ({ ...options, ...(options.ourPids ? { ourPids: options.ourPids.map(foldPid) } : {}) });

/* `harness`:
 *   offered(directory, locks) -> the editors, as the module answers them
 *   connect(agent, directory, { locks, ourPids }) -> the launch decision */
export async function answers(harness) {
  const recorded = {};
  for (const [name, options] of CASES) {
    const directory = await mkdtemp(path.join(tmpdir(), 'rengine-ide-connect-corpus-'));
    const locks = options.locks === null ? path.join(directory, 'missing') : directory;
    for (const [file, value] of Object.entries(options.locks ?? {})) {
      await writeFile(path.join(directory, /\.(lock|txt)$/.test(file) ? file : `${file}.lock`), typeof value === 'string' ? value : JSON.stringify(value));
    }
    const out = [];
    try {
      for (const ask of options.asks) {
        if (ask.offered) out.push({ offered: ask.offered, editors: fold(await harness.offered(ask.offered, locks)) });
        else {
          const [agent, where, inputs] = ask.connect;
          out.push({ connect: [agent, where, foldInputs(inputs)], decision: fold(await harness.connect(agent, where, { ...inputs, locks })) });
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
    /* Through JSON, because the record is JSON: `ideName: undefined` is a key the record does not
       have and `NaN` is null there, and the comparison is between what was written and what would be. */
    recorded[name] = JSON.parse(JSON.stringify(out));
  }
  return recorded;
}

export const RECORDED = await (async () => {
  try { return JSON.parse(await readFile(new URL('./ide-connect-corpus.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

/* The answers `runtime/windows.mjs`'s store gives, recorded before it is replaced (F159, spec 144).
 *
 *   node tests/window-store-corpus.mjs > tests/window-store-corpus.json
 *
 * Six of the supervisor's thirteen routes are this module: project windows, their layouts, and the
 * durable integration transport two agents exchange reports over. It is the part of the supervisor
 * with no process in it and the most contract, so it is the part that can be frozen exactly.
 *
 * Regenerate ONLY from a checkout where `windows.mjs` still holds the store. A record that moved
 * with the implementation would prove nothing (F173).
 *
 * What is recorded is a SEQUENCE against one store rather than a set of independent answers,
 * because most of what this module decides depends on what it was told before: a retry key is only
 * a retry against an existing report, an inbox cursor only means something against a sequence, and
 * `create` answers a window it already has rather than a second one. `@1` in a case means "the id
 * the first create minted", resolved at replay time — the ids themselves are random and the record
 * would be unreplayable with them in it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ORIGIN = 'root-origin', PROJECT = 'root-project', OTHER = 'root-other';
const alpha = { id: PROJECT, name: 'Alpha' }, beta = { id: OTHER, name: 'Beta' };
const report = (extra = {}) => ({ windowId: '@1', key: 'k1', kind: 'issue', summary: 'The adapter drops frames', ...extra });

export const CASES = [
  /* A window is created by the ORIGINATING root against a project root, on behalf of one agent. */
  ['a window is created for an origin, a project and an agent', { call: 'create', originRootId: ORIGIN, project: alpha, agentId: 'agent-1' }],
  ['the same three answer the same window rather than a second one', { call: 'create', originRootId: ORIGIN, project: alpha, agentId: 'agent-1' }],
  ['a different agent on the same pair is a different window', { call: 'create', originRootId: ORIGIN, project: alpha, agentId: 'agent-2' }],
  ['a different project is a different window', { call: 'create', originRootId: ORIGIN, project: beta, agentId: 'agent-1' }],

  /* Both sides of a window can list and read it; nobody else can. */
  ['the origin lists the windows it is on either side of', { call: 'list', rootId: ORIGIN }],
  ['the project side lists the same window from its end', { call: 'list', rootId: PROJECT }],
  ['a root on neither side lists nothing', { call: 'list', rootId: 'root-stranger' }],
  ['the origin reads one window whole', { call: 'get', rootId: ORIGIN, id: '@1' }],
  ['the project side reads it too', { call: 'get', rootId: PROJECT, id: '@1' }],
  ['a root on neither side is refused by name', { call: 'get', rootId: 'root-stranger', id: '@1' }],
  ['an id nobody has is the same refusal', { call: 'get', rootId: ORIGIN, id: 'no-such-window' }],

  /* The layout is the desktop's, saved by id alone — a window's layout is not root-scoped. */
  ['a layout is saved by window id', { call: 'layout', id: '@1', layout: { panes: [{ kind: 'terminal' }] } }],
  ['and read back off the store', { call: 'stateLayout', id: '@1' }],
  ['a window with no layout yet answers null rather than a refusal', { call: 'stateLayout', id: '@3' }],
  ['a layout for an unknown window is refused', { call: 'layout', id: 'no-such-window', layout: { panes: [] } }],
  ['a layout that is not an object is refused', { call: 'layout', id: '@1', layout: 'panes' }],
  ['a layout that is null is refused', { call: 'layout', id: '@1', layout: null }],
  ['a layout past a megabyte is refused', { call: 'layout', id: '@1', layout: { pad: '@big' } }],
  ['the listing never carries a layout', { call: 'list', rootId: ORIGIN }],

  /* The transport. A report is addressed by which SIDE sent it, and lands in the other side's
     inbox — which is the whole of what makes this durable rather than a chat. */
  ['the origin reports to the project side', { call: 'report', rootId: ORIGIN, input: report() }],
  ['the same key and the same content is the same report, reused', { call: 'report', rootId: ORIGIN, input: report() }],
  ['the same key with different content is refused rather than overwritten', { call: 'report', rootId: ORIGIN, input: report({ summary: 'Something else' }) }],
  ['a different key is a second report', { call: 'report', rootId: ORIGIN, input: report({ key: 'k2', kind: 'status', summary: 'Adapter integrated', detail: 'Frames land.', evidence: ['npm test'] }) }],
  ['the project side reports back to the origin', { call: 'report', rootId: PROJECT, input: report({ key: 'k3', summary: 'Fixed upstream' }) }],
  /* `fromProject` is the origin speaking AS the project it opened, so the report lands back in the
     ORIGIN's own inbox: the sender is the project side, and a report always goes to the other one. */
  ['the origin may report AS the project it opened, and that lands back with the origin', { call: 'report', rootId: ORIGIN, input: report({ key: 'k4', summary: 'On behalf of the project', fromProject: true }) }],
  ['the project side may not report as the origin', { call: 'report', rootId: PROJECT, input: report({ key: 'k5', summary: 'Not mine to send', fromProject: true }) }],
  ['a root on neither side cannot report at all', { call: 'report', rootId: 'root-stranger', input: report({ key: 'k6' }) }],
  ['a kind that is neither issue nor status is refused', { call: 'report', rootId: ORIGIN, input: report({ key: 'k7', kind: 'note' }) }],
  ['an empty key is refused', { call: 'report', rootId: ORIGIN, input: report({ key: '' }) }],
  ['a key past 128 characters is refused', { call: 'report', rootId: ORIGIN, input: report({ key: '@key129' }) }],
  ['a summary that is only whitespace is refused', { call: 'report', rootId: ORIGIN, input: report({ key: 'k8', summary: '   ' }) }],
  ['a summary past 2000 characters is refused', { call: 'report', rootId: ORIGIN, input: report({ key: 'k9', summary: '@summary2001' }) }],
  ['a detail past 16000 characters is refused', { call: 'report', rootId: ORIGIN, input: report({ key: 'k10', detail: '@detail16001' }) }],
  ['more than ten pieces of evidence is refused', { call: 'report', rootId: ORIGIN, input: report({ key: 'k11', evidence: '@evidence11' }) }],
  ['a piece of evidence past 2048 characters is refused', { call: 'report', rootId: ORIGIN, input: report({ key: 'k12', evidence: ['@evidence2049'] }) }],
  ['evidence that is not a list is refused', { call: 'report', rootId: ORIGIN, input: report({ key: 'k13', evidence: 'npm test' }) }],

  /* The inbox is the other half: what a root has been sent, in sequence, from a cursor. */
  ['the project side reads what the origin sent it', { call: 'inbox', rootId: PROJECT, options: {} }],
  ['the origin reads what the project side sent it', { call: 'inbox', rootId: ORIGIN, options: {} }],
  ['a cursor takes only what came after it', { call: 'inbox', rootId: PROJECT, options: { after: 1 } }],
  ['a cursor past the end is empty and keeps itself', { call: 'inbox', rootId: PROJECT, options: { after: 999 } }],
  ['an inbox can be narrowed to one window', { call: 'inbox', rootId: PROJECT, options: { windowId: '@1' } }],
  ['a window the caller is on neither side of is refused', { call: 'inbox', rootId: 'root-stranger', options: { windowId: '@1' } }],
  ['the origin may read the inbox of the project it opened', { call: 'inbox', rootId: ORIGIN, options: { windowId: '@1', projectSide: true } }],
  ['the project side may not read the origin inbox that way', { call: 'inbox', rootId: PROJECT, options: { windowId: '@1', projectSide: true } }],
  ['a project-side read with no window named is refused', { call: 'inbox', rootId: ORIGIN, options: { projectSide: true } }],
  ['a cursor that is not a whole number is refused', { call: 'inbox', rootId: PROJECT, options: { after: -1 } }],

  /* Last, because every bound is at its maximum and a record that carried this report through the
     inbox reads above would be mostly filler. */
  ['the bounds themselves are allowed, so they are bounds and not a smaller box', { call: 'report', rootId: ORIGIN, input: report({ key: '@key128', summary: '@summary2000', detail: '@detail16000', evidence: '@evidence10' }) }],
];

/* The long strings the cases above name rather than carry, as a RECIPE rather than the text: the
 * record has to be self-contained — the Rust replays it without reading this file — and a megabyte
 * of `x` written out would be a fixture that is mostly padding.
 */
export const FILLERS = {
  '@big': { repeat: 'x', times: 1024 * 1024 },
  '@key128': { repeat: 'k', times: 128 },
  '@key129': { repeat: 'k', times: 129 },
  '@summary2000': { repeat: 's', times: 2000 },
  '@summary2001': { repeat: 's', times: 2001 },
  '@detail16000': { repeat: 'd', times: 16000 },
  '@detail16001': { repeat: 'd', times: 16001 },
  '@evidence2049': { repeat: 'e', times: 2049 },
  '@evidence10': { each: 'e', times: 10 },
  '@evidence11': { each: 'e', times: 11 },
};

export const expand = filler =>
  'repeat' in filler ? filler.repeat.repeat(filler.times) : Array.from({ length: filler.times }, (_, at) => `${filler.each}${at}`);

/* The record, and how it is made: the sequence above, run against a store of its own, with the ids
 * it mints folded back into `@N` and its clocks into `<time>` — a record carrying a random UUID
 * would be unreplayable, and one carrying `Date.now()` would be wrong a millisecond later.
 */
function resolve(value, minted) {
  if (typeof value === 'string') {
    if (value in FILLERS) return expand(FILLERS[value]);
    const at = /^@(\d+)$/.exec(value);
    return at ? (minted[Number(at[1]) - 1] ?? value) : value;
  }
  if (Array.isArray(value)) return value.map(item => resolve(item, minted));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, minted)]));
  return value;
}

function fold(value, minted) {
  if (typeof value === 'string') {
    const at = minted.indexOf(value);
    return at >= 0 ? `@${at + 1}` : value;
  }
  if (Array.isArray(value)) return value.map(item => fold(item, minted));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, ['createdAt', 'timestamp'].includes(key) && typeof item === 'number' ? '<time>' : fold(item, minted)]));
  }
  return value;
}

/* `answers()` drove `runtime/windows.mjs` and is gone with it (F173): a parity proof cannot outlive the
 * side it compares against, so what the module SAID is the evidence now and the module that said
 * it is deleted. The cases and the record below are what the Rust is judged against, and they are
 * frozen — regenerating them from the implementation they check would prove nothing. To change
 * what is asked, add a case and record it from a checkout that still has the JavaScript, which is
 * to say from history.
 */
export const RECORDED = (() => {
  try { return require('./window-store-corpus.json'); } catch { return null; }
})();

/* Run directly, this says so rather than failing on a name that is not there. A recorder whose
   subject is gone is not broken — it is finished. */
if (process.argv[1] && process.argv[1].endsWith('window-store-corpus.mjs')) {
  console.error('window-store-corpus.json is frozen: runtime/windows.mjs is deleted, so there is nothing left to record from.');
  process.exit(1);
}

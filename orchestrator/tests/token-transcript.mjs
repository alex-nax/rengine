/* The answers the project token ledger gives, recorded before it is replaced (F157, spec 132).
 *
 * A ledger is a STATE MACHINE, so its record is a transcript rather than a set of independent
 * answers: each step is a call, and what it is judged on is the answer, the status the ledger is
 * left in, and the frames it wrote. Replaying the same script against a replacement is the only way
 * to know the replacement holds the same rules — a per-call comparison would miss a cooldown
 * charged to the wrong contest or a deadline that re-timed.
 *
 * The clock and the mint are data (the ledger takes them since this row), so nothing here depends
 * on a draw or on how fast the machine is.
 *
 *   node orchestrator/tests/token-transcript.mjs > orchestrator/tests/token-transcript.json
 *
 * Regenerate ONLY from a checkout where `runtime/token.mjs` still holds the ledger — that is, never
 * again after the deletion commit; the file is the evidence, and a regenerated one would be judging
 * the replacement against itself.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ALICE = { agentId: '11111111-1111-4111-8111-111111111111', label: 'claude aaaa', pid: 4001 };
const BOB = { agentId: '22222222-2222-4222-8222-222222222222', label: 'codex bbbb', pid: 4002 };
const CAROL = { agentId: '33333333-3333-4333-8333-333333333333', label: 'kimi cccc', pid: 4003 };
/* The same agent, resumed: one session id under a new process. Spec 095's Identity rule, and the
   case that once cost a resumed holder its own token. */
const ALICE_RESUMED = { ...ALICE, pid: 4005 };
const ROOT = '44444444-4444-4444-4444-444444444444';
const WINDOW = 60000;

/* The script. Each step names the call and what it is made with; `advance` moves the clock, which is
   how a deadline or a cooldown is reached without waiting for one. */
export const SCRIPT = [
  ['the ledger opens free', { call: 'status' }],
  ['a free token is claimed at once', { call: 'contest', caller: ALICE, reason: 'first' }],
  ['the holder sees that it holds it', { call: 'status', caller: ALICE }],
  ['another agent sees that it does not', { call: 'status', caller: BOB }],
  ['the holder contesting its own token is told so', { call: 'contest', caller: ALICE }],
  ['a second agent opens a contest', { call: 'contest', caller: BOB, reason: 'my turn' }],
  ['a third agent is refused while one is open', { call: 'contest', caller: CAROL }],
  ['a non-holder cannot reject', { call: 'reject', caller: CAROL }],
  ['the holder rejects it', { call: 'reject', caller: ALICE, reason: 'mid-write' }],
  ['the rejected agent is in cooldown', { call: 'contest', caller: BOB }],
  ['and says so until the cooldown ends', { call: 'status', caller: BOB }],
  ['the clock passes the cooldown', { advance: WINDOW + 1000 }],
  ['so it may contest again', { call: 'contest', caller: BOB, reason: 'again' }],
  ['the clock passes the deadline', { advance: WINDOW + 1000 }],
  /* Nothing has run: a read that settles nothing still shows the old holder, which is why every
     caller settles first and why this records both views. */
  ['a read that settles nothing still shows the old holder', { call: 'rawStatus', caller: BOB }],
  ['and the token transfers when anything settles', { call: 'status', caller: BOB }],
  ['the new holder releases it', { call: 'release', caller: BOB }],
  ['a release under a contest answers the contest', { call: 'contest', caller: ALICE }],
  ['with a contester waiting', { call: 'contest', caller: BOB }],
  ['and the holder letting go', { call: 'release', caller: ALICE }],
  ['the desktop revokes what it finds', { call: 'desktop', action: 'revoke', desktopId: 'desk-1' }],
  ['and cannot revoke nothing', { call: 'desktop', action: 'revoke', desktopId: 'desk-1' }],
  ['the desktop assigns to an agent it has seen', { call: 'desktop', action: 'assign', agentId: ALICE.agentId, desktopId: 'desk-1' }],
  ['but not to one it has not', { call: 'desktop', action: 'assign', agentId: '99999999-9999-4999-8999-999999999999', desktopId: 'desk-1' }],
  ['a grant needs a contest', { call: 'desktop', action: 'grant', desktopId: 'desk-1' }],
  ['so one is opened', { call: 'contest', caller: CAROL, reason: 'please' }],
  ['and a grant must name it', { call: 'desktop', action: 'grant', desktopId: 'desk-1' }],
  ['by its own id', { call: 'desktop', action: 'grant', contestId: 'not-the-open-one', desktopId: 'desk-1' }],
  ['which the desktop then grants', { call: 'desktop', action: 'grant', contestId: 'open', desktopId: 'desk-1' }],
  ['a holder whose process left is not holding', { call: 'gone', pid: CAROL.pid }],
  ['so the next contest claims it outright', { call: 'contest', caller: ALICE, reason: 'it went away' }],
  ['the refusal a tool shows while another holds it', { call: 'refusal', caller: BOB, tool: 'task_add' }],
  ['and the one it shows when the token is free', { call: 'desktop', action: 'free', desktopId: 'desk-1' }],
  ['reads differently', { call: 'refusal', caller: BOB, tool: 'task_add' }],
  ['the desktop segment a status bar reads', { call: 'segment' }],
  ['and the frames a monitor resumes from', { call: 'feed', cursor: 0 }],

  /* Identity is the agent's SESSION, not its process (spec 095): a resumed session is the same
     agentId under a new pid, so the hold stands and liveness follows the process running it now.
     Without this the resumed holder reads as gone and loses its own token to the next contester. */
  ['an agent takes the free token', { call: 'contest', caller: ALICE, reason: 'resuming' }],
  ['its process ends', { call: 'gone', pid: ALICE.pid }],
  ['the same session comes back under a new process', { call: 'contest', caller: ALICE_RESUMED }],
  ['so another agent opens a contest rather than claiming it', { call: 'contest', caller: BOB, reason: 'is it free?' }],
];

export async function transcript() {
  const { Ledger } = await import('../runtime/token.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-token-record-'));
  const steps = [];
  try {
    /* A clock that only moves when the script says so, ids that count, and a set of processes that
       have gone away — every input this ledger has, made data. */
    let clock = Date.parse('2026-09-14T12:00:00.000Z');
    let minted = 0;
    const dead = new Set();
    const ledger = await Ledger.open(path.join(directory, ROOT), ROOT, {
      window: () => WINDOW,
      alive: pid => !dead.has(pid),
      now: () => clock,
      mint: () => `c0ffee${String(++minted).padStart(2, '0')}-0000-4000-8000-000000000000`,
    });
    const answer = async step => {
      if (step.advance !== undefined) { clock += step.advance; return { advanced: step.advance }; }
      switch (step.call) {
        /* What a caller goes through, which is `settle` and then `status`: the ledger's own
           `status()` is a synchronous read that settles nothing, and the worker awaits a settle
           before every answer (worker.mjs:143, :233). A transcript that called `status` alone would
           record a view no caller ever sees — and would let a replacement skip the settle. */
        case 'status': await ledger.settle(); return ledger.status(step.caller ?? null);
        case 'rawStatus': return ledger.status(step.caller ?? null);
        case 'segment': return ledger.segment();
        case 'refusal': return { refusal: ledger.refusal(step.caller, step.tool) };
        case 'feed': return ledger.feed.after(step.cursor ?? 0);
        case 'gone': dead.add(step.pid); return { gone: step.pid };
        case 'contest': return ledger.contest(step.caller, step.reason ?? '');
        case 'reject': return ledger.reject(step.caller, step.reason ?? '');
        case 'release': return ledger.release(step.caller);
        case 'desktop': {
          /* `open` stands for whatever contest is open now, so the script can name it without
             knowing which id the mint produced. */
          const contestId = step.contestId === 'open' ? ledger.state.contest?.id : step.contestId;
          return ledger.desktop(step.action, { ...step, contestId });
        }
        default: throw new Error(`unknown call ${step.call}`);
      }
    };
    for (const [name, step] of SCRIPT) {
      let result;
      try { result = { ok: await answer(step) }; }
      catch (error) { result = { refused: { message: error.message, status: error.status ?? null } }; }
      steps.push({ name, ...result, status: ledger.status(step.caller ?? null) });
    }
    await ledger.drained();
    ledger.close();
    /* The two files the ledger leaves behind, which is what a replaced worker reads. */
    const file = async name => JSON.parse(await readFile(path.join(directory, ROOT, name), 'utf8'));
    return { steps, ledger: await file('token.json'), feed: await file('feed.json') };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export const RECORDED = await (async () => {
  try { return JSON.parse(await readFile(new URL('./token-transcript.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.log(JSON.stringify(await transcript(), null, 2));
}

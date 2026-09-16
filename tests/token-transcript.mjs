/* The answers the project token ledger gave, recorded before it was replaced (F157, spec 132).
 *
 * A ledger is a STATE MACHINE, so its record is a transcript rather than a set of independent
 * answers: each step is a call, and what it is judged on is the answer, the status the ledger is
 * left in, and the frames it wrote. Replaying the same script against the replacement is the only
 * way to know the replacement holds the same rules — a per-call comparison would miss a cooldown
 * charged to the wrong contest or a deadline that re-timed.
 *
 * `runtime/token.mjs` is gone; `red-token` answers now, and `token-parity.test.mjs` replays this
 * script against it through `red-token-replay`. **There is no recorder here any more, and that is
 * deliberate**: the record was made from the JavaScript while the JavaScript existed, and one
 * regenerated from the replacement would be judging the replacement against itself. The script and
 * the record are frozen together — a step added now would have no recorded answer to be right or
 * wrong about.
 *
 * The clock, the mint and the window preference are data, so nothing here depends on a draw or on
 * how fast the machine is.
 */
import { readFile } from 'node:fs/promises';

const ALICE = { agentId: '11111111-1111-4111-8111-111111111111', label: 'claude aaaa', pid: 4001 };
const BOB = { agentId: '22222222-2222-4222-8222-222222222222', label: 'codex bbbb', pid: 4002 };
const CAROL = { agentId: '33333333-3333-4333-8333-333333333333', label: 'kimi cccc', pid: 4003 };
/* The same agent, resumed: one session id under a new process. Spec 095's Identity rule, and the
   case that once cost a resumed holder its own token. */
const ALICE_RESUMED = { ...ALICE, pid: 4005 };
export const ROOT = '44444444-4444-4444-4444-444444444444';
export const WINDOW = 60000;
export const STARTED_AT = Date.parse('2026-09-14T12:00:00.000Z');
/* Ids that count rather than draw. Exported because the replacement is replayed against this same
   script and must mint the same ids: a second copy of this formula is a second thing to get wrong. */
export const mintOf = ordinal => `c0ffee${String(ordinal).padStart(2, '0')}-0000-4000-8000-000000000000`;

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

  /* The desktop answering an open contest (spec 103 decision 5). The contester did nothing wrong,
     so it is charged nothing — the one branch `settleRejection`'s `cooldown: false` exists for, and
     a branch nothing above reaches: every assign so far has met a free token. */
  ['the desktop assigns while a contest is open', { call: 'desktop', action: 'assign', agentId: ALICE.agentId, desktopId: 'desk-1' }],
  ['and charges the contester it answered nothing', { call: 'contest', caller: BOB, reason: 'straight back' }],

  /* The window a contest was opened under travels WITH the contest. Changing the preference must
     not re-time a deadline already running, and must not change what rejecting it costs; the next
     contest is the first to use the new length. Nothing above ever changes the preference. */
  ['the window preference is halved', { window: WINDOW / 2 }],
  ['the open contest keeps the deadline it was opened with', { call: 'status', caller: BOB }],
  ['and rejecting it charges the window it ran on', { call: 'reject', caller: ALICE_RESUMED, reason: 'still writing' }],
  ['while the next contest opens on the new one', { call: 'contest', caller: CAROL, reason: 'after the change' }],
];

export const RECORDED = await (async () => {
  try { return JSON.parse(await readFile(new URL('./token-transcript.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

/* The thin client of the red-token service (F157, spec 132): the exact `Tokens`/`Ledger` surface
 * `token.mjs` presented — methods, answers, refusal wording and `status` statuses — while the
 * ledger itself is `red-token`, judged against the transcript recorded from the JavaScript this
 * replaces (`tests/token-transcript.json`).
 *
 * One difference the socket forces, and it is recorded rather than hidden: the reads that were
 * synchronous are promises now. `status`, `refusal`, `seen`, `frame` and `segment` cross a socket,
 * so the worker awaits them. Everything else — what each answers, in what words, leaving what on
 * disk — is the same, which is what the parity spec is for.
 *
 * Two things stay here because they are neither state nor a question for the service: the header
 * readers and `segmentFrame`, which a retired worker applies to ANOTHER worker's status relayed
 * over HTTP. `red-token` holds the same three (`Identity::from_headers`, `read_desktop`,
 * `segment_frame`) for the day red-host answers these routes; these die with `worker.mjs` (F158).
 */
import { ServiceClient } from './service-client.mjs';

export const DEFAULT_WINDOW_MS = 60000;
export const MIN_WINDOW_MS = 250;
export const MAX_WINDOW_MS = 60 * 60 * 1000;
export const TOKEN_PROTOCOL = 1;

const printable = (value, limit) => typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, '').slice(0, limit) : '';
export const UUID = /^[0-9a-f-]{36}$/;
/* An identity is whatever the caller put on the wire. The token is arbitration among cooperating
   agents, never an access boundary: every participant already holds the workspace capability, so
   a lie here buys nothing that was not already reachable (spec 095, "What the token is not"). */
export function readIdentity(headers) {
  const agentId = headers['x-rengine-agent'];
  if (typeof agentId !== 'string' || !UUID.test(agentId)) return null;
  const pid = Number(headers['x-rengine-agent-pid']);
  return { agentId, label: printable(headers['x-rengine-agent-label'], 64) || 'agent',
    ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) };
}
/* The desktop a retired workspace worker acts for, carried on X-Rengine-Desktop when that worker
   forwards a retained desktop's frame to the current one (spec 095, Retirement). */
export function readDesktop(headers) { return printable(headers['x-rengine-desktop'], 64) || null; }
/* The pinned worker->desktop frame, built from a status object rather than from ledger internals, so
   the worker that owns the ledger and a retired worker relaying that ledger through the supervisor
   put the same bytes on the desktop's socket. */
export function segmentFrame(status) {
  const contest = status.contest;
  return { type: 'token', rootId: status.rootId, holder: status.holder ?? null,
    contest: contest ? { id: contest.id, contester: contest.contester, openedAt: contest.openedAt, deadline: contest.deadline, reason: contest.reason ?? '' } : null,
    windowMs: status.window, sequence: status.tokenSequence };
}

/* One root's ledger, as a handle on the service rather than an object holding state. Nothing is
   cached here: the service is the one owner of the ledger (charter D61's rule for the store, and
   the reason this row is a service at all), so a second host attaching to the same directory reads
   the same holder rather than a copy of it. */
class LedgerClient {
  constructor(tokens, rootId) { this.tokens = tokens; this.rootId = rootId; this.feed = new FeedClient(tokens, rootId); }
  ask(method, ...args) { return this.tokens.client.call(method, [this.rootId, ...args]); }

  settle() { return this.ask('settle'); }
  seen(who) { return this.ask('seen', who ?? null); }
  persist() { return this.ask('persist'); }
  status(caller = null) { return this.ask('status', caller); }
  refusal(caller, tool) { return this.ask('refusal', caller ?? null, tool ?? null); }
  segment() { return this.ask('segment'); }
  frame(type, by, fields = {}) { return this.ask('frame', type, by, fields); }
  contest(caller, reason = '') { return this.ask('contest', caller, reason); }
  reject(caller, reason = '') { return this.ask('reject', caller, reason); }
  release(caller) { return this.ask('release', caller); }
  /* What the worker's gate does, in one call: settle, note the caller, ask for the refusal, persist.
     Four calls would also be four moments another attached host could move the ledger between. */
  gate(caller, tool) { return this.ask('gate', caller ?? null, tool ?? null).then(answer => answer.refusal); }
  /* And what every token-aware answer carries: the same settle-and-note, then the status a caller
     sees and the refusal beside it. */
  callerStatus(caller, tool) { return this.ask('callerStatus', caller ?? null, tool ?? null); }
  /* `lookup` was a function the worker handed the ledger, and a function does not cross a socket, so
     what it would have answered travels with the request. Asking it for every assign rather than
     only when the ledger does not know the agent is one extra read of the worker's own state. */
  desktop(action, { contestId, desktopId, reason = '', agentId, lookup } = {}) {
    const found = action === 'assign' && typeof lookup === 'function' && agentId ? lookup(agentId) : null;
    return this.ask('desktop', action, { contestId: contestId ?? null, desktopId: desktopId ?? null, reason, agentId: agentId ?? null, lookup: found ?? null });
  }
  /* The service writes before it answers, so there is nothing left in flight to drain. */
  drained() { return Promise.resolve(); }
  close() { /* the ledger belongs to the service, which belongs to the directory */ }
  /** Every status this root's ledger pushes, which is what fed the desktop's segment. */
  watch(listener) { return this.tokens.listen('status', this.rootId, listener); }
}

/* The ring, as the worker uses it: a cursor read and a subscription. The frames themselves are the
   service's — a monitor's sequence must never rewind, and it cannot if only one process mints it. */
class FeedClient {
  constructor(tokens, rootId) { this.tokens = tokens; this.rootId = rootId; }
  after(cursor = 0, limit) { return this.tokens.client.call('feedAfter', [this.rootId, cursor, limit ?? null]); }
  subscribe(listener) { return this.tokens.listen('frame', this.rootId, listener); }
  drained() { return Promise.resolve(); }
}

export class Tokens {
  /** The state directory's token service: found if one is running, started if not. */
  static async open(directory, options = {}) {
    const tokens = new Tokens(directory);
    tokens.client = await ServiceClient.attach(directory, {
      name: 'token', protocol: TOKEN_PROTOCOL, variable: 'RENGINE_RED_TOKEN_SERVE', basename: 'red-token-serve',
      env: options.env ?? process.env, onEvent: event => tokens.heard(event),
    });
    tokens.preferences = tokens.client.greeting?.preferences ?? {};
    return tokens;
  }

  constructor(directory) {
    this.directory = directory;
    this.client = null;
    /* A local copy of the workspace preferences, refreshed by the service's own push. `window()` is
       read inside a response literal the worker builds synchronously, and a preference is not worth
       a round trip there — the service says so whenever it changes, including when another host
       changed it. */
    this.preferences = {};
    this.listeners = { frame: new Set(), status: new Set() };
  }

  heard(event) {
    if (event.event === 'preferences') { this.preferences = event.preferences ?? {}; return; }
    const listeners = this.listeners[event.event];
    if (!listeners) return;
    for (const entry of listeners) {
      if (entry.rootId !== event.rootId) continue;
      /* One bad desktop never stops the others. */
      try { entry.listener(event.event === 'frame' ? event.frame : event.status); } catch { /* ignored */ }
    }
  }

  listen(kind, rootId, listener) {
    const entry = { rootId, listener };
    this.listeners[kind].add(entry);
    return () => this.listeners[kind].delete(entry);
  }

  window() {
    const value = this.preferences.tokenWindowMs;
    return Number.isSafeInteger(value) && value >= MIN_WINDOW_MS && value <= MAX_WINDOW_MS ? value : DEFAULT_WINDOW_MS;
  }

  async bumpGeneration() {
    const next = await this.client.call('bumpGeneration');
    this.preferences = await this.client.call('preferences');
    return next;
  }

  async setWindow(value) {
    this.preferences = await this.client.call('setWindow', [value]);
    return this.preferences;
  }

  async ledger(rootId) {
    if (!UUID.test(rootId ?? '')) { const error = new Error('Unknown project root.'); error.status = 404; throw error; }
    /* The handle is cheap and stateless, but the service is asked to OPEN the ledger here, so a
       root whose directory cannot be read fails where the JS `Ledger.open` failed. */
    await this.client.call('settle', [rootId]);
    return new LedgerClient(this, rootId);
  }

  /** Closing leaves the service running: it belongs to the directory, not to this worker. */
  close() { return this.client ? this.client.close() : Promise.resolve(); }
}

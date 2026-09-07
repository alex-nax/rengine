import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Feed, writeAtomically } from './feed.mjs';

export const DEFAULT_WINDOW_MS = 60000;
export const MIN_WINDOW_MS = 250;
export const MAX_WINDOW_MS = 60 * 60 * 1000;
const HISTORY = 50;
const IDENTITIES = 64;

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
const seconds = ms => `${Math.max(0, Math.round(ms / 1000))}s`;
function elapsed(since) {
  const ms = Date.now() - Date.parse(since);
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const total = Math.round(ms / 1000);
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`;
}

/* One ledger per project root, persisted atomically as token.json in the runtime directory so a
   replaced workspace worker resumes the same holder and the same absolute deadline. */
export class Ledger {
  constructor(directory, rootId, feed, { window = () => DEFAULT_WINDOW_MS, alive = () => true } = {}) {
    this.directory = directory; this.rootId = rootId; this.feed = feed; this.windowOf = window; this.alive = alive;
    this.file = path.join(directory, 'token.json');
    this.state = { version: 1, rootId, holder: null, contest: null, cooldown: {}, sequence: 0, tokenSequence: 0, identities: {}, history: [] };
    this.writing = Promise.resolve(); this.timer = null; this.watchers = new Set();
  }
  static async open(directory, rootId, options) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const feed = await Feed.open(directory, rootId);
    const ledger = new Ledger(directory, rootId, feed, options);
    await ledger.load();
    return ledger;
  }
  async load() {
    let value;
    try { value = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') { this.arm(); return; } throw error; }
    if (!value || value.version !== 1 || value.rootId !== this.rootId) throw new Error('Token ledger belongs to another project root.');
    this.state = { ...this.state, ...value, rootId: this.rootId,
      cooldown: value.cooldown && typeof value.cooldown === 'object' ? value.cooldown : {},
      identities: value.identities && typeof value.identities === 'object' ? value.identities : {},
      history: Array.isArray(value.history) ? value.history : [] };
    this.arm();
  }
  persist() {
    this.writing = this.writing.then(() => writeAtomically(this.file, this.state)).catch(() => {});
    return this.writing;
  }
  drained() { return Promise.all([this.writing, this.feed.drained()]); }
  close() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  watch(listener) { this.watchers.add(listener); return () => this.watchers.delete(listener); }

  window() {
    const value = this.windowOf();
    return Number.isSafeInteger(value) && value >= MIN_WINDOW_MS && value <= MAX_WINDOW_MS ? value : DEFAULT_WINDOW_MS;
  }
  /* Deadlines are absolute wall times, and the timer is only an optimisation: every call settles
     first, so a worker replaced mid-contest resolves at the original time from the file alone. */
  arm() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const deadline = this.state.contest ? Date.parse(this.state.contest.deadline) : NaN;
    if (!Number.isFinite(deadline)) return;
    this.timer = setTimeout(() => { this.timer = null; void this.settle(); }, Math.max(0, deadline - Date.now()));
    this.timer.unref?.();
  }
  frame(type, by, fields) {
    const frame = this.feed.emit(type, by, fields);
    this.state.sequence = frame.sequence;
    if (type.startsWith('token.')) this.state.tokenSequence = frame.sequence;
    this.state.history.push({ sequence: frame.sequence, at: frame.at, type, by });
    if (this.state.history.length > HISTORY) this.state.history.splice(0, this.state.history.length - HISTORY);
    for (const watcher of this.watchers) { try { watcher(this.status()); } catch { /* one bad desktop never stops the others */ } }
    return frame;
  }
  seen(identity) {
    if (!identity) return;
    const known = this.state.identities[identity.agentId];
    this.state.identities[identity.agentId] = { agentId: identity.agentId, label: identity.label,
      ...(identity.pid ? { pid: identity.pid } : {}), firstSeenAt: known?.firstSeenAt ?? new Date().toISOString(), lastSeenAt: new Date().toISOString() };
    /* The identity is the agent's session, not its process (spec 095, Identity): a resumed session
       is the same agentId under a new pid, so the hold stands and liveness follows the process that
       is running it now. Without this the resumed holder reads as gone and loses its own token. */
    if (identity.pid && this.state.holder?.agentId === identity.agentId && this.state.holder.pid !== identity.pid) {
      this.state.holder = { ...this.state.holder, pid: identity.pid };
    }
    const entries = Object.entries(this.state.identities);
    if (entries.length > IDENTITIES) {
      entries.sort((a, b) => Date.parse(a[1].lastSeenAt) - Date.parse(b[1].lastSeenAt));
      for (const [agentId] of entries.slice(0, entries.length - IDENTITIES)) delete this.state.identities[agentId];
    }
  }
  gone(holder) { return Boolean(holder) && Number.isSafeInteger(holder.pid) && holder.pid > 0 && !this.alive(holder.pid); }

  /* Applied before every read and every call: the deadline that passed while nobody was looking,
     and the holder whose process left, resolve here rather than waiting for a timer to fire. */
  async settle() {
    let changed = false;
    for (const [agentId, until] of Object.entries(this.state.cooldown)) {
      if (!(Date.parse(until) > Date.now())) { delete this.state.cooldown[agentId]; changed = true; }
    }
    const contest = this.state.contest;
    if (contest && Date.parse(contest.deadline) <= Date.now()) {
      this.state.contest = null;
      this.state.holder = { ...contest.contester, since: new Date().toISOString() };
      this.frame('token.claimed', { kind: 'deadline' }, { holder: this.state.holder, contestId: contest.id });
      changed = true;
    }
    if (changed) { this.arm(); await this.persist(); }
    return changed;
  }
  status(caller = null) {
    const contest = this.state.contest;
    return { rootId: this.rootId, holder: this.state.holder, window: this.window(),
      contest: contest ? { ...contest, secondsRemaining: Math.max(0, Math.round((Date.parse(contest.deadline) - Date.now()) / 1000)) } : null,
      holdsToken: Boolean(caller && this.state.holder?.agentId === caller.agentId),
      holderAlive: this.state.holder ? !this.gone(this.state.holder) : null,
      cooldown: this.state.cooldown, identities: Object.values(this.state.identities),
      sequence: this.state.sequence, tokenSequence: this.state.tokenSequence, feedCursor: this.feed.sequence,
      history: this.state.history.slice(-10) };
  }
  /* The frame the native status-bar segment reads, pinned flat rather than as the agent-facing
     status object: holder, contest, the window in milliseconds, and the sequence of the last
     token.* frame so a desktop can tell a stale push from a new one. */
  segment() {
    const contest = this.state.contest;
    return { type: 'token', rootId: this.rootId, holder: this.state.holder,
      contest: contest ? { id: contest.id, contester: contest.contester, openedAt: contest.openedAt, deadline: contest.deadline, reason: contest.reason ?? '' } : null,
      windowMs: this.window(), sequence: this.state.tokenSequence };
  }
  /* Decision 5: refuse by name, attempt nothing. A free token is refused too, because holding is
     deliberate — token_contest claims a free token at once, and the claim is a frame everybody sees. */
  refusal(caller, tool) {
    const named = tool ? `${tool} ` : '';
    if (!caller) return null;
    const holder = this.state.holder;
    if (holder && holder.agentId === caller.agentId) return null;
    if (!holder) {
      return `The project token for this root is free, and ${named}needs it. Nothing was attempted. Call token_contest: a free token is claimed at once.`;
    }
    const contest = this.state.contest;
    return `The project token is held by ${holder.label} (${holder.agentId}) since ${holder.since} (${elapsed(holder.since)} ago)`
      + `, and ${named}needs it. Nothing was attempted. Call token_contest to open a ${seconds(this.window())} window`
      + (contest ? `; ${contest.contester.label} already has one open until ${contest.deadline}.` : '; the holder or the person at the desktop may reject it, otherwise the token transfers to you at the deadline.');
  }

  async contest(caller, reason = '') {
    await this.settle();
    this.seen(caller);
    const holder = this.state.holder;
    if (holder?.agentId === caller.agentId) { await this.persist(); return { state: 'held', holder, detail: 'This agent already holds the token.' }; }
    const cooldown = this.state.cooldown[caller.agentId];
    if (cooldown && Date.parse(cooldown) > Date.now()) {
      const error = new Error(`This agent's contest was rejected and it cannot contest again until ${cooldown} (${seconds(Date.parse(cooldown) - Date.now())} from now).`);
      throw Object.assign(error, { status: 409 });
    }
    if (this.state.contest) {
      const open = this.state.contest;
      const error = new Error(`${open.contester.label} (${open.contester.agentId}) already has a contest open until ${open.deadline}. Wait for it to resolve.`);
      throw Object.assign(error, { status: 409 });
    }
    const contester = { agentId: caller.agentId, label: caller.label, ...(caller.pid ? { pid: caller.pid } : {}) };
    if (!holder || this.gone(holder)) {
      const by = holder ? { kind: 'holder-gone' } : { kind: 'agent', agentId: caller.agentId, label: caller.label };
      const previous = holder;
      this.state.holder = { ...contester, since: new Date().toISOString() };
      this.frame('token.claimed', by, { holder: this.state.holder, ...(previous ? { previousHolder: previous } : {}) });
      await this.persist();
      return { state: 'claimed', holder: this.state.holder, by: by.kind };
    }
    const openedAt = new Date().toISOString();
    /* The window a contest was opened under travels with it: the deadline is fixed at this instant,
       and so is the cooldown a rejection of it costs. Changing the preference re-times nothing. */
    const windowMs = this.window();
    this.state.contest = { id: randomUUID(), contester, openedAt, windowMs,
      deadline: new Date(Date.now() + windowMs).toISOString(), reason: printable(reason, 200) };
    this.frame('token.contested', { kind: 'agent', agentId: caller.agentId, label: caller.label },
      { contestId: this.state.contest.id, contester, holder, deadline: this.state.contest.deadline, reason: this.state.contest.reason });
    this.arm(); await this.persist();
    return { state: 'pending', contestId: this.state.contest.id, deadline: this.state.contest.deadline, holder };
  }
  async reject(caller, reason = '') {
    await this.settle();
    this.seen(caller);
    const contest = this.state.contest;
    if (!contest) throw Object.assign(new Error('No contest is open on this root.'), { status: 409 });
    if (this.state.holder?.agentId !== caller.agentId) throw Object.assign(new Error(this.refusal(caller, 'token_reject')), { status: 409 });
    return this.settleRejection(contest, { kind: 'agent', agentId: caller.agentId, label: caller.label }, reason);
  }
  async settleRejection(contest, by, reason) {
    const until = new Date(Date.now() + (contest.windowMs ?? this.window())).toISOString();
    this.state.contest = null;
    this.state.cooldown[contest.contester.agentId] = until;
    this.frame('token.rejected', by, { contestId: contest.id, contester: contest.contester, holder: this.state.holder,
      reason: printable(reason, 200) || 'no reason given', cooldownUntil: until });
    this.arm(); await this.persist();
    return { state: 'rejected', contestId: contest.id, cooldownUntil: until, holder: this.state.holder };
  }
  /* A release under an open contest is that contest answered, not a token left lying free: the
     contester would otherwise wait out a window for a token nobody holds, and could not even
     re-contest, because a second contest is refused while one is open. */
  async release(caller) {
    await this.settle();
    this.seen(caller);
    if (this.state.holder?.agentId !== caller.agentId) throw Object.assign(new Error(this.refusal(caller, 'token_release')), { status: 409 });
    const holder = this.state.holder, contest = this.state.contest;
    if (contest) {
      this.state.contest = null;
      this.state.holder = { ...contest.contester, since: new Date().toISOString() };
      this.frame('token.claimed', { kind: 'release', agentId: holder.agentId, label: holder.label },
        { holder: this.state.holder, previousHolder: holder, contestId: contest.id });
      this.arm(); await this.persist();
      return { state: 'claimed', holder: this.state.holder, previousHolder: holder, contestId: contest.id, by: 'release' };
    }
    this.state.holder = null;
    this.frame('token.released', { kind: 'agent', agentId: caller.agentId, label: caller.label }, { holder });
    await this.persist();
    return { state: 'free', previousHolder: holder };
  }
  /* Decision 6: the person at the desktop is never gated. These four are that person's acts. */
  async desktop(action, { contestId, desktopId, reason = '' } = {}) {
    await this.settle();
    const by = { kind: 'desktop', desktopId: printable(desktopId, 64) || 'desktop' };
    const contest = this.state.contest;
    if (action === 'reject' || action === 'grant') {
      if (!contest) throw Object.assign(new Error('No contest is open on this root.'), { status: 409 });
      if (!contestId) throw Object.assign(new Error(`Name the contest to ${action}: the open one is ${contest.id}.`), { status: 400 });
      if (contestId !== contest.id) throw Object.assign(new Error('That contest is no longer the open one.'), { status: 409 });
    }
    if (action === 'reject') return this.settleRejection(contest, by, reason);
    if (action === 'grant') {
      this.state.contest = null;
      this.state.holder = { ...contest.contester, since: new Date().toISOString() };
      this.frame('token.claimed', by, { holder: this.state.holder, contestId: contest.id });
      this.arm(); await this.persist();
      return { state: 'claimed', holder: this.state.holder, by: 'desktop' };
    }
    if (action === 'revoke' || action === 'free') {
      if (!this.state.holder) throw Object.assign(new Error('Nobody holds the token on this root.'), { status: 409 });
      const holder = this.state.holder;
      this.state.holder = null;
      this.frame(action === 'revoke' ? 'token.revoked' : 'token.released', by, { holder });
      await this.persist();
      return { state: 'free', previousHolder: holder };
    }
    throw Object.assign(new Error('Choose reject, grant, revoke or free.'), { status: 400 });
  }
}

/* The per-root ledgers a worker serves, plus the one workspace preference the ledger reads. The
   host's preference store allowlists its keys and silently drops the ones it does not know, so
   tokenWindowMs is kept here, beside the ledgers, and merged into the state the worker answers. */
export class Tokens {
  constructor(directory, options = {}) {
    this.directory = path.join(directory, 'tokens'); this.options = options;
    this.file = path.join(this.directory, 'preferences.json');
    this.ledgers = new Map(); this.opening = new Map(); this.preferences = {};
  }
  static async open(directory, options) {
    const tokens = new Tokens(directory, options);
    await mkdir(tokens.directory, { recursive: true, mode: 0o700 });
    try { const value = JSON.parse(await readFile(tokens.file, 'utf8')); if (value && typeof value === 'object') tokens.preferences = value; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return tokens;
  }
  window() {
    const value = this.preferences.tokenWindowMs;
    return Number.isSafeInteger(value) && value >= MIN_WINDOW_MS && value <= MAX_WINDOW_MS ? value : DEFAULT_WINDOW_MS;
  }
  /* The generation a replaced workspace worker announces. It lives beside the window because both
     are workspace-wide rather than per root, and both have to survive the worker that reads them. */
  async bumpGeneration() {
    const next = (Number.isSafeInteger(this.preferences.generation) ? this.preferences.generation : 0) + 1;
    this.preferences = { ...this.preferences, generation: next };
    await writeAtomically(this.file, this.preferences);
    return next;
  }
  async setWindow(value) {
    if (!Number.isSafeInteger(value) || value < MIN_WINDOW_MS || value > MAX_WINDOW_MS) {
      throw Object.assign(new Error(`Invalid tokenWindowMs preference; expected an integer between ${MIN_WINDOW_MS} and ${MAX_WINDOW_MS}.`), { status: 400 });
    }
    this.preferences = { ...this.preferences, tokenWindowMs: value };
    await writeAtomically(this.file, this.preferences);
    /* Nothing is re-armed: an open contest carries the window it opened under, its deadline is an
       absolute wall time, and the next contest is the first to use the new length. */
    return this.preferences;
  }
  ledger(rootId) {
    if (!UUID.test(rootId ?? '')) throw Object.assign(new Error('Unknown project root.'), { status: 404 });
    const existing = this.ledgers.get(rootId);
    if (existing) return Promise.resolve(existing);
    if (!this.opening.has(rootId)) {
      const flight = Ledger.open(path.join(this.directory, rootId), rootId,
        { window: () => this.window(), alive: this.options.alive })
        .then(ledger => { this.ledgers.set(rootId, ledger); return ledger; })
        .finally(() => this.opening.delete(rootId));
      this.opening.set(rootId, flight);
    }
    return this.opening.get(rootId);
  }
  async close() {
    for (const ledger of this.ledgers.values()) { ledger.close(); await ledger.drained(); }
  }
}

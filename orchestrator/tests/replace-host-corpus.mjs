/* The answers `launcher/replace.mjs` gives about a process table, recorded before it is replaced
 * (F159, spec 144; spec 098).
 *
 *   node orchestrator/tests/replace-host-corpus.mjs > orchestrator/tests/replace-host-corpus.json
 *
 * What this module decides is **which process gets a SIGTERM**, from a descriptor that names a pid
 * and a `ps` table that may have recycled it. Every refusal in it is a refusal to signal: a pid that
 * is not a session host, a host that serves a different directory, a launcher running inside the
 * workspace it would replace. Getting one wrong does not produce a wrong answer — it stops somebody
 * else's work.
 *
 * The table is the one the JavaScript's own suite was written against: a machine with one
 * workspace's host and a pane inside it, two sibling projects' instances, a supervisor with its
 * worker and desktop, a worktree's preflight host, and a state directory with a space in its name.
 * Nothing here is ever signalled; the table is data.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const HIREBASE = '/home/x/.local/state/redit/hirebase-v2';
const VTMB = '/home/x/.local/state/rengine/vtmb-vr-2249049057';
const NOLF = '/home/x/.local/state/rengine/nolf-improved-2056293539';

export const TABLE_TEXT = `
    1     0 /sbin/launchd
 9599     1 /usr/bin/node /home/x/rengine/orchestrator/runtime/supervisor.mjs
 9600     1 /home/x/rengine/red/target/debug/red-supervisor --state /home/x/rengine/.cache/runtime/d5fe12fe
 9603  9599 /home/x/rengine/red/target/debug/red-worker --state /home/x/rengine/.cache/runtime/d5fe12fe --host http://127.0.0.1:1234
82044  9599 /home/x/rengine/.cache/runtime/d5fe12fe/versions/ccd74ad2/bin/rengine --control
68944     1 /usr/bin/node /home/x/rengine/orchestrator/server/main.mjs --state ${HIREBASE}
12336 68944 /usr/bin/node /home/x/rengine/scripts/../orchestrator/agents/launch.mjs claude /usr/bin/claude
12342 12336 /usr/bin/claude --mcp-config ${HIREBASE}/integrations/x/mcp.json
94222 12342 /bin/zsh -c source snapshot.sh
90297     1 /usr/bin/node /home/x/vtmb-vr/third_party/rengine/orchestrator/server/main.mjs --state ${VTMB}
90359     1 /usr/bin/node /home/x/vtmb-vr/third_party/rengine/orchestrator/runtime/supervisor.mjs
60124     1 /usr/bin/node /home/x/nolf-improved/third_party/rengine/orchestrator/server/main.mjs --state ${NOLF}
44686     1 /usr/bin/node /home/x/nolf-improved/third_party/rengine/orchestrator/server/main.mjs --state /home/x/.local/state/rengine
29815     1 /usr/bin/node /home/x/rengine/.cache/worktrees/agent-token-2/orchestrator/server/main.mjs --state /var/folders/T/rengine-preflight-rjyCY8
77001     1 /usr/bin/node /home/x/rengine/orchestrator/server/main.mjs --state /home/x/My Workspaces/with space
`;

const descriptor = pid => ({ pid, url: 'http://127.0.0.1:61942', token: 'f'.repeat(64), instance: 'd5fe12fe' });

/* Each case names what is being asked and of what. `alive` is handed in rather than measured: the
   pids in this table belong to a machine that is not this one. */
export const CASES = [
  ['the table is parsed, spaces in a state directory and all', { call: 'parseProcessTable' }],

  /* A host is spawned as exactly [main.mjs, '--state', DIR], so the directory is the tail — and a
     tail with a space in it is one directory, not two. */
  ['a session host names the directory it serves', { call: 'hostArguments', command: '/usr/bin/node /home/x/rengine/orchestrator/server/main.mjs --state /home/x/My Workspaces/with space' }],
  ['a host started from a worktree is still a host', { call: 'hostArguments', command: `/usr/bin/node /home/x/rengine/.cache/worktrees/agent-token-2/orchestrator/server/main.mjs --state /var/folders/T/rengine-preflight-rjyCY8` }],
  ['a supervisor is not a host', { call: 'hostArguments', command: '/usr/bin/node /home/x/rengine/orchestrator/runtime/supervisor.mjs' }],
  ['an agent CLI is not a host', { call: 'hostArguments', command: '/usr/bin/claude --mcp-config /x/mcp.json' }],
  ['a host with no --state is not one this may act on', { call: 'hostArguments', command: '/usr/bin/node /home/x/rengine/orchestrator/server/main.mjs' }],

  /* Ancestry: a launcher inside the workspace it would replace dies with the host it signals. */
  ['a pane deep inside a host knows its ancestors', { call: 'ancestorsOf', pid: 94222 }],
  ['a launcher inside the workspace is recognised', { call: 'insideHost', hostPid: 68944, self: 94222 }],
  ['a launcher outside it is not', { call: 'insideHost', hostPid: 68944, self: 90297 }],
  ['and a host is not inside itself', { call: 'insideHost', hostPid: 68944, self: 68944 }],

  /* Which command lines count as a supervisor: the module a workspace started before the port is
     still running, and the binary every workspace starts now. */
  ['the JavaScript supervisor is one', { call: 'supervises', command: '/usr/bin/node /home/x/rengine/orchestrator/runtime/supervisor.mjs' }],
  ['the binary is one', { call: 'supervises', command: '/home/x/rengine/red/target/debug/red-supervisor --state /home/x/rengine/.cache/runtime/d5fe12fe' }],
  ['a worker under it is not', { call: 'supervises', command: '/home/x/rengine/red/target/debug/red-worker --state /x --host http://127.0.0.1:1234' }],
  ['and neither is a desktop', { call: 'supervises', command: '/home/x/rengine/.cache/runtime/d5fe12fe/versions/ccd74ad2/bin/rengine --control' }],

  /* The host of a directory: its descriptor's pid, and only if that pid serves that directory. */
  ['the host a descriptor names', { call: 'findHost', stateDir: HIREBASE, descriptor: descriptor(68944), alive: [68944] }],
  ['a descriptor naming a pid that is gone is stale', { call: 'findHost', stateDir: HIREBASE, descriptor: descriptor(68944), alive: [] }],
  ['a descriptor naming a pid nothing in the table has is stale', { call: 'findHost', stateDir: HIREBASE, descriptor: descriptor(11111), alive: [11111] }],
  ['no descriptor at all is nothing to replace', { call: 'findHost', stateDir: HIREBASE, descriptor: null, alive: [] }],
  ['a pid that is alive but is not a host is refused by name', { call: 'findHost', stateDir: HIREBASE, descriptor: descriptor(12342), alive: [12342] }],
  ['a host serving ANOTHER directory is refused by name', { call: 'findHost', stateDir: HIREBASE, descriptor: descriptor(90297), alive: [90297] }],

  /* The report a person reads afterwards. Every line of it is what happened to a process. */
  ['a replacement that stopped a host, its supervisor and its children', { call: 'describeReport', report: 'full' }],
  ['a replacement with nothing running', { call: 'describeReport', report: 'empty' }],
  ['a stale descriptor, cleared', { call: 'describeReport', report: 'stale' }],
  ['no host recorded at all', { call: 'describeReport', report: 'none' }],
  ['a host that would not say what it was holding', { call: 'describeReport', report: 'silent' }],
];

const STARTED = new Date('2026-09-10T08:30:00.000Z');

export const REPORTS = {
  full: {
    stateDir: HIREBASE,
    previous: { pid: 68944, url: 'http://127.0.0.1:61942', instance: 'd5fe12fe', startedAt: STARTED, command: 'node main.mjs' },
    ended: [
      { id: 's1', type: 'agent', title: 'claude · hirebase', agent: 'claude', conversation: '287bba3a' },
      { id: 's2', type: 'terminal', title: 'build' },
    ],
    stopped: [
      { role: 'supervisor', pid: 9599, outcome: 'stopped on SIGTERM' },
      { role: 'supervisor child', pid: 82044, outcome: 'ignored SIGTERM, killed' },
      { role: 'host', pid: 68944, outcome: 'stopped on SIGTERM' },
      { role: 'host child', pid: 12336, outcome: 'already gone' },
    ],
    retained: [{ role: 'pty service', pid: 10282 }, { role: 'store service', pid: 10280 }],
    started: { pid: 70001, url: 'http://127.0.0.1:61999', instance: 'ab12cd34', checkout: '/home/x/rengine/' },
  },
  empty: {
    stateDir: HIREBASE,
    previous: { pid: 68944, url: 'http://127.0.0.1:61942', instance: 'd5fe12fe', startedAt: null, command: 'node main.mjs' },
    ended: [], stopped: [{ role: 'host', pid: 68944, outcome: 'stopped on SIGTERM' }], retained: [],
    started: { pid: 70001, url: 'http://127.0.0.1:61999', instance: 'ab12cd34', checkout: '/home/x/rengine/' },
  },
  stale: {
    stateDir: HIREBASE,
    previous: { pid: 68944, url: 'http://127.0.0.1:61942', instance: 'd5fe12fe', stale: true },
    ended: [], stopped: [], retained: [],
    started: { pid: 70001, url: 'http://127.0.0.1:61999', instance: 'ab12cd34', checkout: '/home/x/rengine/' },
  },
  none: {
    stateDir: HIREBASE, previous: null, ended: [], stopped: [], retained: [],
    started: { pid: 70001, url: 'http://127.0.0.1:61999', instance: 'ab12cd34', checkout: '/home/x/rengine/' },
  },
  silent: {
    stateDir: HIREBASE,
    previous: { pid: 68944, url: 'http://127.0.0.1:61942', instance: 'd5fe12fe', startedAt: STARTED, command: 'node main.mjs' },
    ended: [], stopped: [{ role: 'host', pid: 68944, outcome: 'stopped on SIGTERM' }], retained: [],
    note: 'the host did not answer /api/state before it was stopped (fetch failed); its running sessions could not be listed',
    started: { pid: 70001, url: 'http://127.0.0.1:61999', instance: 'ab12cd34', checkout: '/home/x/rengine/' },
  },
};

export async function answers() {
  const replace = await import('../launcher/replace.mjs');
  const table = replace.parseProcessTable(TABLE_TEXT);
  const recorded = [];
  for (const [name, op] of CASES) {
    let answer;
    try {
      if (op.call === 'parseProcessTable') answer = { value: table };
      else if (op.call === 'hostArguments') answer = { value: replace.hostArguments(op.command) };
      else if (op.call === 'ancestorsOf') answer = { value: replace.ancestorsOf(op.pid, table) };
      else if (op.call === 'insideHost') answer = { value: replace.insideHost(op.hostPid, table, op.self) };
      else if (op.call === 'supervises') answer = { value: replace.supervises(op.command) };
      else if (op.call === 'findHost') {
        const live = new Set(op.alive);
        const found = await replace.findHost(op.stateDir, { processes: table, descriptor: op.descriptor, alive: pid => live.has(pid) });
        answer = { value: { descriptor: found.descriptor, pid: found.process?.pid ?? null, stale: found.stale ?? false } };
      } else if (op.call === 'describeReport') answer = { value: replace.describeReport(REPORTS[op.report]) };
      else throw new Error(`Unknown call ${op.call}`);
    } catch (error) {
      answer = { refused: error.message };
    }
    recorded.push({ name, op, answer });
  }
  return { recordedFrom: 'orchestrator/launcher/replace.mjs', recordedAt: '2026-09-16', table: TABLE_TEXT,
    why: 'F173: a parity proof cannot outlive the side it compares against. What this module decides is which process gets a SIGTERM, and these are the answers it gave on the day red-supervisor replaced it. Never regenerate: a record that moves with the implementation proves nothing.',
    cases: recorded };
}

export const RECORDED = (() => {
  try { return require('./replace-host-corpus.json'); } catch { return null; }
})();

if (process.argv[1] && process.argv[1].endsWith('replace-host-corpus.mjs')) {
  process.stdout.write(`${JSON.stringify(await answers(), null, 2)}\n`);
}

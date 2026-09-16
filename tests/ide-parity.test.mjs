/* F161 (spec 102, spec 133): the Rust IDE bridge answers the recorded corpus.
 *
 * The record was proved to be what the JavaScript bridge said by `ide-record.test.mjs`, which went
 * with the implementation it judged (77595e5 holds both). This drives `red-ide serve` over stdio,
 * the way `ide.mjs` drives it, through the same steps with the same raw WebSocket client, and
 * compares every frame as text: the lock as written, the sweep, the token gate, the SDK's answers
 * and its silences, the retake. The second test reads the rules back out of the record, so a
 * record that lost one is a red test rather than a quiet edit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, RECORDED, SOURCES, answers } from './ide-corpus.mjs';
import { rustHarness } from './ide-serve-client.mjs';
import { built } from './cargo.mjs';

test('the Rust IDE bridge gives the recorded answers', { timeout: 600000 }, async () => {
  await built('-p', 'red-ide', '--bin', 'red-ide');
  assert.ok(RECORDED, 'ide-corpus.json is present');
  const harness = await rustHarness();
  let live;
  try { live = await answers(harness); } finally { await harness.finish(); }
  const drift = CASES.map(([name]) => name).filter(name => JSON.stringify(live[name]) !== JSON.stringify(RECORDED[name]));
  for (const name of drift) assert.deepEqual(live[name], RECORDED[name], name);
  assert.deepEqual(drift, [], 'every case answers as recorded');
});

test('a source that is not there is asked nothing', async () => {
  assert.equal(SOURCES.none, null, 'the corpus names a bridge with no source, and the harness starts it without asks');
});

test('the corpus holds the rules the bridge is for', () => {
  const of = name => RECORDED[name];
  const step = (name, index) => of(name)[index];
  const lockText = (name, index) => step(name, index).disk.find(entry => entry.name === '<port>.lock').text;

  /* The lock is what the CLI parses: the port is the filename, the pid is the HOST's, and the mark
     that says it is ours rides along under a key the CLI's parser ignores. */
  const lock = JSON.parse(lockText('the lock is the one the CLI reads', 1).replaceAll('<product>', 'P').replaceAll('<token>', 'T'));
  assert.deepEqual(Object.keys(lock), ['pid', 'workspaceFolders', 'ideName', 'transport', 'useWebSocket', 'runningInWindows', 'authToken', 'rengineWorker']);
  assert.equal(lock.pid, 4242, 'the lock names the host, not the worker');
  assert.equal(lock.rengineWorker, 99);
  assert.equal(lock.useWebSocket, true);
  assert.equal(step('the lock is the one the CLI reads', 1).disk[0].mode, '600');
  assert.equal(step('the lock is the one the CLI reads', 1).directoryMode, '700');
  assert.deepEqual(step('the lock is the one the CLI reads', 3).disk, [], 'close unlinks the lock the CLI would never collect');

  /* Without the host's pid nothing is published and nothing is touched. */
  for (const index of [0, 1, 2, 3]) {
    assert.equal(step('without a host pid nothing is published, four ways', index).published, false);
    assert.match(step('without a host pid nothing is published, four ways', index).reason, /session host process could not be identified/);
  }
  assert.deepEqual(step('without a host pid nothing is published, four ways', 4).disk, [], 'the directory was not even created');

  /* The worker pid defaults to the process that asked. */
  assert.match(lockText('the worker pid defaults to the caller', 1), /"rengineWorker": <self>/);

  /* The sweep takes ours whose worker is gone — and a pid it cannot signal counts as gone — and
     leaves every other IDE's lock alone, whatever it looks like. */
  assert.deepEqual(step('the startup sweep collects only ours, and only the dead', 0).swept, ['<dir>/111.lock', '<dir>/1212.lock', '<dir>/777.lock']);
  const left = step('the startup sweep collects only ours, and only the dead', 1).disk.map(entry => entry.name);
  assert.ok(left.includes('333.lock'), "another IDE's lock is none of our business");
  assert.ok(left.includes('444.lock'), 'a worker named as a string is not a worker we can vouch for');
  assert.ok(left.includes('222.lock'), 'a live worker keeps its lock');
  assert.ok(!step('the startup sweep collects only ours, and only the dead', 3).disk.some(entry => entry.name === '1313.lock'), 'startup sweeps too');
  assert.deepEqual(step('a sweep of a directory that is not there', 0).swept, []);

  /* MCP: the SDK's shapes, byte for byte, and the frames it does not answer. */
  const mcp = of('the MCP handshake, the tool list, and every silence');
  const answered = index => mcp[index].answered;
  assert.equal(answered(2), '{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"rengine-ide","version":"1.0.0"}},"jsonrpc":"2.0","id":1}');
  assert.match(answered(4), /^\{"result":\{"tools":\[\{"name":"getDiagnostics","description":"Diagnostics <product> holds for a file/, 'slice 1 serves exactly one tool');
  assert.equal(answered(5), '{"result":{},"jsonrpc":"2.0","id":3}');
  assert.equal(answered(6), '{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"Method not found"}}');
  for (const index of [3, 8, 9, 10, 11, 12, 13, 14, 15]) assert.equal(mcp[index].silent, true, `frame ${index} is not answered: ${JSON.stringify(mcp[index].sent)}`);
  assert.match(answered(17), /"protocolVersion":"2025-11-25"/, 'an unknown version is answered in the latest');
  assert.match(answered(18), /"protocolVersion":"2024-11-05"/, 'a known version is echoed');
  assert.equal(mcp[1].protocol, 'mcp', 'the subprotocol the CLI asks for is echoed back');
  assert.deepEqual(mcp.at(-1).clientsSaw, { a: { code: 1005, reason: '' }, b: { code: 1005, reason: '' } });

  /* getDiagnostics answers a list, never a refusal, and an unknown tool is refused by name. */
  const diagnostics = of('getDiagnostics, every way it can be asked');
  assert.match(diagnostics[2].answered, /\\"uri\\":\\"file:\/\/\/work\/a\.c\\",\\"diagnostics\\":\[\{/);
  assert.match(diagnostics[3].answered, /\\"uri\\":\\"\\"/, 'no arguments means an empty uri, not a refusal');
  assert.match(diagnostics[5].answered, /\\"uri\\":5/, 'the uri is passed through as given');
  assert.equal(diagnostics[8].answered, '{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"openDiff is not a tool <product> serves yet."}}');
  const sources = of('diagnostics from every kind of source');
  assert.match(sources[2].answered, /\\"diagnostics\\":\[\]/, 'a source that answers nothing is an empty list');
  assert.match(sources[6].answered, /\\"diagnostics\\":\[\]/, 'so is one that answers null');
  assert.equal(sources[10].answered, '{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"the language server is on fire"}}');
  assert.match(sources[14].answered, /\\"diagnostics\\":\[\]/, 'and no source at all');

  /* The token gate: one header, the one the CLI uses, and nothing else is trusted for being local. */
  const gate = of('the token gate, in every place a token could be presented');
  const verdict = index => gate[index].verdict ?? gate[index];
  for (const [index, why] of [[1, 'no token'], [2, 'the wrong token'], [3, 'the token in the query string'], [6, 'the header twice'], [8, 'an empty header']]) {
    assert.deepEqual(verdict(index).closed, { code: 1008, reason: 'A valid IDE token is required.' }, why);
  }
  assert.equal(gate[4].error, 'Server sent no subprotocol', 'the token as a subprotocol is not a subprotocol we echo');
  assert.ok(verdict(5).answered, 'a header name is case-insensitive');
  assert.ok(verdict(9).answered, 'the right token in the right header');
  assert.equal(gate[10].clients, 3);
  const observed = gate[11].observed;
  assert.equal(observed.length, 9);
  assert.deepEqual(observed.map(entry => entry.accepted), [false, false, false, false, true, false, true, false, true]);
  assert.deepEqual(observed.map(entry => entry.where), [null, null, null, null, 'header', null, 'header', null, 'header']);
  assert.ok(observed.every(entry => !('sec-websocket-key' in entry.headers)), 'the key is not recorded');

  /* The subprotocol: echoed when offered, absent when not, and a malformed offer is a 400. */
  const sub = of('the subprotocol is echoed when asked for, and only then');
  assert.equal(sub[1].protocol, 'mcp');
  assert.equal(sub[2].error, 'Server sent no subprotocol');
  assert.equal(sub[3].protocol, 'mcp');
  assert.equal(sub[4].protocol, '');
  assert.equal(sub[5].error, 'Unexpected server response: 400');

  /* Fan-out: every connected CLI, in the CLI's own vocabulary, and the count is the truth. */
  const fan = of('a selection and a mention reach every connected CLI');
  assert.equal(fan[1].delivered, 0);
  assert.equal(fan[5].delivered, 2);
  assert.match(fan[5].received.a, /^\{"method":"selection_changed","params":\{"filePath":"\/work\/a\.c"/);
  assert.match(fan[6].received.b, /^\{"method":"at_mentioned","params":\{"filePath":"\/work\/a\.c","lineStart":2,"lineEnd":4\},"jsonrpc":"2\.0"\}$/);
  assert.deepEqual(fan[9], { disconnected: 'a', clients: 1 });
  assert.equal(fan[10].delivered, 1);

  /* Close: the lock goes, the sockets go, the port is released. */
  const close = of('closing the bridge removes its lock and ends its sockets');
  assert.deepEqual(close[4].disk, []);
  assert.equal(close[5].connectAfterClose, 'ECONNREFUSED');

  /* The port belongs to the runtime: a successor waits for it and never settles for another. */
  const retake = of('the port survives a worker replacement');
  assert.equal(retake[1].published, false);
  assert.equal(retake[1].reason, 'port <port> is still held by the worker being replaced');
  assert.deepEqual(retake[4], { ready: true, reason: null, published: true, port: '<port>', lock: '<dir>/<port>.lock' });
  assert.match(retake[5].disk[0].text, /"rengineWorker": 2/);
  const never = of('a port that is never released is a named absence');
  assert.equal(never[2].ready, false);
  assert.equal(never[2].reason, 'port <port> was never released by the worker being replaced');
  assert.equal(step('a wanted port that is free is taken at once', 0).wantedTaken, true);
  /* A successor retired while waiting stops waiting: it does not take the port after its own
     retirement, and no lock appears that nobody would unlink. */
  const retired = of('a successor closed while waiting stops waiting');
  assert.deepEqual(retired[2], { closedAll: ['second', 'first'] }, 'the closes are concurrent, which is what makes the rule observable');
  assert.equal(retired[3].ready, false);
  assert.deepEqual(retired[4].disk, []);

  /* A slow source does not hold the next frame behind it: the SDK answered each request on its
     own promise, and so must the port. */
  assert.deepEqual(step('a slow source does not hold the next frame behind it', 2), { burst: ['diagnostics', 'ping'], answered: ['ping', 'diagnostics'] });

  /* A directory that cannot be created is the OS's own sentence, thrown. */
  assert.equal(step('a lock directory that cannot be created', 0).error, "EEXIST: file already exists, mkdir '<dir>/afile'");
  assert.equal(step('a lock directory that cannot be created', 1).error, "ENOTDIR: not a directory, mkdir '<dir>/afile/ide'");

  /* The lock directory: rEngine's override, then CLAUDE_CONFIG_DIR, then the CLI's own path. */
  const where = of('the lock directory follows the CLI, unless rEngine says otherwise').map(entry => entry.directory);
  assert.deepEqual(where, ['<home>/.claude/ide', '/cfg/ide', '/explicit', 'ide', '/cfg/ide', 'relative/cfg/ide', '/x/y/ide', '/cfg/ide']);
});

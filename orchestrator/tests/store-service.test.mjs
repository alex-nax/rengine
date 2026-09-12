/* F174 (F170a, spec 129, KI-095): the stdio red-store service and its thin client. The client
 * presents the exact WorkspaceStore surface — results, and `fail` statuses over the hop — while
 * the store itself runs in a Rust process speaking newline-delimited JSON-RPC, the house's
 * LSP/MCP-worker shape. Proof is the F169 corpus replayed through the client: the harness
 * injects the recorded mints and stamps (RED_STORE_MINT_SEQUENCE/RED_STORE_NOW_SEQUENCE,
 * harness-only) because byte parity includes what the service mints. Lifecycle: the service
 * exits when its stdin closes, so a dead host leaves no store process behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVE = path.join(ROOT, 'red/target/debug/red-store-serve');
const run = promisify(execFile);

const STAMPS = [1_800_000_000_000, 1_800_000_060_000, 1_800_000_120_000, 1_800_000_180_000];

/* The same corpus the F169 harness builds, replayed through the client. Every op's result,
   error(+status) and the workspace.json bytes after it are compared against the recording. */
async function replay(corpus, directory, client) {
  const mints = [];
  for (const op of corpus.ops) {
    if (op.op === 'addRoot' && op.result?.id && !mints.includes(op.result.id)) mints.push(op.result.id);
  }
  const env = { ...process.env, RED_STORE_MINT_SEQUENCE: mints.join(','), RED_STORE_NOW_SEQUENCE: STAMPS.join(',') };
  const store = await client.WorkspaceStore.open(path.join(directory, 'state'), { env });
  const drift = [];
  const judge = (label, expected, actual) => {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) drift.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const mapPaths = value => JSON.parse(JSON.stringify(value).replaceAll('<DIR>', directory));
  const unmapPaths = value => JSON.parse(JSON.stringify(value).replaceAll(directory, '<DIR>'));
  let opIndex = 0;
  const dispatch = async (op, args) => {
    switch (op) {
      case 'addRoot': return store.addRoot(...args);
      case 'preferences': return store.preferences(...args);
      case 'putDraft': return store.putDraft(...args);
      case 'discardDraft': { await store.discardDraft(...args); return null; }
      case 'recordConversation': return store.recordConversation(...args);
      case 'saveLayout': { await store.saveLayout(...args); return null; }
      case 'list': case 'list-hidden': return store.list(...args);
      case 'readText': return store.readText(...args);
      case 'resolve': { const [absolute, relative] = await store.resolve(...args); return { absolute, relative }; }
      case 'saveText': return store.saveText(...args);
      default: throw new Error(`unknown op ${op}`);
    }
  };
  const runOp = async (op, fileState) => {
    let result = null, error = null;
    try { result = await dispatch(op.op, mapPaths(op.args)); }
    catch (caught) { error = { message: caught.message, status: caught.status ?? null }; }
    judge(`op ${op.op} result`, op.result, unmapPaths(result));
    judge(`op ${op.op} error`, op.error, unmapPaths(error));
    opIndex += 1;
    if (fileState) {
      const file = existsSync(store.filename) ? unmapPaths(await readFile(store.filename, 'utf8')) : null;
      judge(`op ${op.op} file`, op.file, file);
    }
  };
  for (const op of corpus.ops) await runOp(op, true);
  const rootA = corpus.ops[0].result.id;
  const rootB = corpus.ops[2].result.id;
  judge('readback', corpus.readback, unmapPaths({
    draft: await store.getDraft(rootA, 'notes/todo.md'),
    conversationsA: await store.listConversations(rootA),
    conversationsB: await store.listConversations(rootB),
    preferences: store.state.preferences,
  }));
  for (const op of corpus.fileOps) {
    if (op.op === 'fileBytes') {
      const bytes = await readFile(path.join(directory, 'tree', op.args[0]), 'utf8');
      judge(`fileOp fileBytes ${op.args[0]}`, op.result, bytes);
    } else {
      await runOp(op, false);
    }
  }
  for (const kase of corpus.schema) {
    const errors = await client.validateSchema(kase.schema, kase.value);
    judge(`schema ${kase.name}`, kase.errors, errors);
  }
  await store.close();
  return drift;
}

async function buildTree(directory, spec) {
  for (const entry of spec) {
    const target = entry.path.startsWith('<DIR>') ? entry.path.replace('<DIR>', directory) : path.join(directory, 'tree', entry.path);
    if (entry.dir) await mkdir(target, { recursive: true });
    else if (entry.symlink) await symlink(entry.symlink.replace('<DIR>', directory), target, 'dir').catch(() => {});
    else if (entry.base64) await writeFile(target, Buffer.from(entry.base64, 'base64'));
    else if (entry.repeat) await writeFile(target, entry.repeat[0].repeat(entry.repeat[1]));
    else await writeFile(target, entry.text);
  }
}

test('the corpus replays through the client and service, drift-free', async t => {
  await run('cargo', ['build', '-p', 'red-store', '--bin', 'red-store-serve'], { cwd: path.join(ROOT, 'red') });
  assert.ok(existsSync(SERVE), `red-store-serve was built at ${SERVE}`);
  const client = await import('../server/store-client.mjs');
  const corpusDir = await mkdtemp(path.join(tmpdir(), 'rengine-service-corpus-'));
  t.after(() => rm(corpusDir, { recursive: true, force: true }));
  const corpus = JSON.parse(await readFile(path.join(ROOT, 'orchestrator/tests/store-corpus.json'), 'utf8'));
  const corpusFile = path.join(corpusDir, 'corpus.json');
  await writeFile(corpusFile, JSON.stringify(corpus));

  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-service-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'project-a', 'notes'), { recursive: true });
  await mkdir(path.join(directory, 'project-b'));
  await writeFile(path.join(directory, 'decl.json'), '{}');
  await buildTree(directory, corpus.tree);
  const drift = await replay(corpus, await realpath(directory), client);
  assert.deepEqual(drift, [], `${drift.length} disagreement(s):\n${drift.slice(0, 5).join('\n')}`);
});

test('the service exits when its stdin closes; a reopened client answers', async t => {
  const client = await import('../server/store-client.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-service-life-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await client.WorkspaceStore.open(directory);
  const pid = store.pid;
  assert.ok(pid > 0, 'the client names the service process');
  const root = await store.addRoot(directory);
  assert.equal(root.name, path.basename(directory), 'answers before close');
  await store.close();
  const gone = await new Promise(resolve => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      try { process.kill(pid, 0); if (Date.now() < deadline) return setTimeout(poll, 50); resolve(false); }
      catch { resolve(true); }
    };
    poll();
  });
  assert.ok(gone, `service PID ${pid} exited after close()`);
  const reopened = await client.WorkspaceStore.open(directory);
  assert.deepEqual((await reopened.listConversations(root.id)), [], 'a reopened client reads the same state');
  assert.equal((await reopened.root(root.id)).id, root.id, 'and the root survived on disk');
  await reopened.close();
});

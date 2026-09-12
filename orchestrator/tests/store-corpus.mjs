/* The red-store parity corpus builder (F169, F147a) — the regeneration TOOL for
 * orchestrator/tests/store-corpus.json, not part of the suite's run path. The frozen fixture
 * was captured from the real JS host on 2026-09-12, before F175 deleted store.mjs; a
 * regeneration now drives the client (post-swap answers) and is a deliberate refresh, never a
 * witness of the old host. Importing this module runs the capture; it is not a test.
 */

const STAMPS = [1_800_000_000_000, 1_800_000_060_000, 1_800_000_120_000, 1_800_000_180_000];
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

async function capture(directory) {
  const { WorkspaceStore } = await import('../server/store-client.mjs');
  const projectA = path.join(directory, 'project-a');
  const projectB = path.join(directory, 'project-b');
  await mkdir(projectA, { recursive: true });
  await mkdir(path.join(projectA, 'notes'), { recursive: true });
  await mkdir(projectB, { recursive: true });
  const declaration = path.join(directory, 'decl.json');
  await writeFile(declaration, '{}');

  const realDirectory = (await import('node:fs/promises')).realpath ? await (await import('node:fs/promises')).realpath(directory) : directory;
  const placeholders = new Map();
  const normalize = value => {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value)
      .replaceAll(realDirectory.split(path.sep).join('/'), '<DIR>')
      .replaceAll(directory.split(path.sep).join('/'), '<DIR>')
      .replace(UUID_PATTERN, match => {
        if (!placeholders.has(match)) placeholders.set(match, `00000000-0000-4000-8000-${String(placeholders.size + 1).padStart(12, '0')}`);
        return placeholders.get(match);
      }));
  };

  const ops = [];
  const realNow = Date.now;
  Date.now = () => STAMPS[Math.min(ops.length, STAMPS.length - 1)];
  try {
    const store = await WorkspaceStore.open(path.join(directory, 'state'));
    const record = async (op, args, runOp) => {
      let raw = null, error = null;
      try { raw = await runOp(); }
      catch (caught) { error = { message: caught.message, status: caught.status ?? null }; }
      ops.push({ op, args: normalize(args), result: normalize(raw), error: normalize(error),
        file: existsSync(store.filename) ? normalize(await readFile(store.filename, 'utf8')) : null });
      return raw;
    };
    const addedA = await record('addRoot', [projectA], () => store.addRoot(projectA));
    await record('addRoot', [projectA], () => store.addRoot(projectA));
    const addedB = await record('addRoot', [projectB, declaration], () => store.addRoot(projectB, declaration));
    await record('addRoot', [projectB, path.join(directory, 'other.json')], () => store.addRoot(projectB, path.join(directory, 'other.json')));
    const rootA = addedA.id;
    const rootB = addedB.id;
    await record('preferences', [{ agent: 'codex', vim: true }], () => store.preferences({ agent: 'codex', vim: true }));
    await record('preferences', [{ accentHue: 123.75, recording: { seconds: 30 }, themes: { [rootA]: 'teal' } }],
      () => store.preferences({ accentHue: 123.75, recording: { seconds: 30 }, themes: { [rootA]: 'teal' } }));
    await record('preferences', [{ accentHue: 360 }], () => store.preferences({ accentHue: 360 }));
    await record('preferences', [{ recording: { nonsense: 1 } }], () => store.preferences({ recording: { nonsense: 1 } }));
    await record('putDraft', [{ rootId: rootA, path: 'notes/todo.md', text: '# draft\n', baseVersion: null }],
      () => store.putDraft({ rootId: rootA, path: 'notes/todo.md', text: '# draft\n', baseVersion: null }));
    await record('putDraft', [{ rootId: rootA, path: 'x.md', text: '', baseVersion: 42 }],
      () => store.putDraft({ rootId: rootA, path: 'x.md', text: '', baseVersion: 42 }));
    await record('discardDraft', [rootA, 'notes/todo.md'], () => store.discardDraft(rootA, 'notes/todo.md'));
    await record('recordConversation', [rootA, { conversation: '3f85774e-05bb-4791-bb9f-1c90dc37d0e6' }],
      () => store.recordConversation(rootA, { conversation: '3f85774e-05bb-4791-bb9f-1c90dc37d0e6' }));
    await record('recordConversation', [rootA, { conversation: 'session_3f85774e-05bb-4791-bb9f-1c90dc37d0e6', agent: 'kimi' }],
      () => store.recordConversation(rootA, { conversation: 'session_3f85774e-05bb-4791-bb9f-1c90dc37d0e6', agent: 'kimi' }));
    await record('recordConversation', [rootA, { conversation: '3f85774e-05bb-4791-bb9f-1c90dc37d0e6', agent: 'codex', task: 'F169' }],
      () => store.recordConversation(rootA, { conversation: '3f85774e-05bb-4791-bb9f-1c90dc37d0e6', agent: 'codex', task: 'F169' }));
    await record('recordConversation', [rootA, { conversation: '3f85774e-05bb-4791-bb9f-1c90dc37d0e6', agent: 'codex', task: null }],
      () => store.recordConversation(rootA, { conversation: '3f85774e-05bb-4791-bb9f-1c90dc37d0e6', agent: 'codex', task: null }));
    await record('recordConversation', [rootA, { conversation: 'not-a-session' }],
      () => store.recordConversation(rootA, { conversation: 'not-a-session' }));
    await record('recordConversation', [rootA, { conversation: '3f85774e-05bb-4791-bb9f-1c90dc37d0e6', agent: 'kimi' }],
      () => store.recordConversation(rootA, { conversation: '3f85774e-05bb-4791-bb9f-1c90dc37d0e6', agent: 'kimi' }));
    await record('recordConversation', ['00000000-0000-4000-8000-000000000099', { conversation: '3f85774e-05bb-4791-bb9f-1c90dc37d0e6' }],
      () => store.recordConversation('00000000-0000-4000-8000-000000000099', { conversation: '3f85774e-05bb-4791-bb9f-1c90dc37d0e6' }));
    for (let index = 0; index < 25; index++) {
      const conversation = `3f85774e-05bb-4791-bb9f-${String(index).padStart(12, '0')}`;
      await record('recordConversation', [rootB, { conversation }], () => store.recordConversation(rootB, { conversation }));
    }
    await record('saveLayout', [{ panes: [{ id: 1, ratio: 0.5 }] }], () => store.saveLayout({ panes: [{ id: 1, ratio: 0.5 }] }));
    await record('saveLayout', [{ pad: 'x'.repeat(1024 * 1024) }], () => store.saveLayout({ pad: 'x'.repeat(1024 * 1024) }));

    /* The tree root is an op like any other: the replay does what the recording says, and the
       final state carries it. */

    const readback = normalize({
      draft: store.getDraft(rootA, 'notes/todo.md'),
      conversationsA: store.listConversations(rootA),
      conversationsB: store.listConversations(rootB),
      preferences: store.state.preferences,
    });

    /* The file tree, recorded so the replay rebuilds it byte-for-byte. */
    const tree = path.join(directory, 'tree');
    const treeSpec = [
      { path: 'src', dir: true }, { path: 'src/deep', dir: true },
      { path: 'src/main.c', text: 'int main(void) {\n  return 0;\n}\n' },
      { path: 'win.txt', text: 'one\r\ntwo\r\n' },
      { path: 'bom.txt', text: '﻿bom\n' },
      { path: 'bin.dat', base64: 'AAECAw==' },
      { path: 'bad.txt', base64: '//5B' },
      { path: 'big.txt', repeat: ['x', 2 * 1024 * 1024 + 1] },
      { path: 'src/deep/leaf.md', text: 'leaf\n' },
      { path: '.hidden', text: 'secret\n' },
      { path: '<DIR>/outside', dir: true },
      { path: 'escape', symlink: '<DIR>/outside' },
    ];
    for (const entry of treeSpec) {
      const target = path.join(tree, entry.path);
      if (entry.dir) await mkdir(entry.path.startsWith('<DIR>') ? entry.path.replace('<DIR>', directory) : target, { recursive: true });
      else if (entry.symlink) await symlink(entry.symlink.replace('<DIR>', directory), target, 'dir').catch(() => {});
      else if (entry.base64) await writeFile(target, Buffer.from(entry.base64, 'base64'));
      else if (entry.repeat) await writeFile(target, entry.repeat[0].repeat(entry.repeat[1]));
      else await writeFile(target, entry.text);
    }
    const filesRoot = (await record('addRoot', [tree], () => store.addRoot(tree))).id;
    const fileOps = [];
    const recordFile = async (op, args, runOp) => {
      let result = null, error = null;
      try { result = await runOp(); }
      catch (caught) { error = { message: caught.message, status: caught.status ?? null }; }
      fileOps.push({ op, args: normalize(args), result: normalize(result), error: normalize(error) });
    };
    await recordFile('list', [filesRoot, ''], () => store.list(filesRoot, ''));
    await recordFile('list', [filesRoot, 'src'], () => store.list(filesRoot, 'src'));
    await recordFile('list-hidden', [filesRoot, '', true], () => store.list(filesRoot, '', true));
    for (const file of ['src/main.c', 'win.txt', 'bom.txt', 'bin.dat', 'bad.txt', 'big.txt', 'missing.md']) {
      await recordFile('readText', [filesRoot, file], () => store.readText(filesRoot, file));
    }
    await recordFile('resolve', [filesRoot, '/etc/passwd'], () => store.resolve(filesRoot, '/etc/passwd'));
    await recordFile('resolve', [filesRoot, '../../etc/passwd'], () => store.resolve(filesRoot, '../../etc/passwd'));
    await recordFile('resolve', [filesRoot, 'a\0b'], () => store.resolve(filesRoot, 'a\0b'));
    await recordFile('resolve', [filesRoot, 'escape/outside'], () => store.resolve(filesRoot, 'escape/outside'));
    const fresh = await store.readText(filesRoot, 'src/main.c');
    await recordFile('saveText', [{ rootId: filesRoot, path: 'src/main.c', text: 'int main(void) {\n  return 1;\n}\n', version: fresh.version }],
      () => store.saveText({ rootId: filesRoot, path: 'src/main.c', text: 'int main(void) {\n  return 1;\n}\n', version: fresh.version }));
    await recordFile('saveText', [{ rootId: filesRoot, path: 'src/main.c', text: 'stale\n', version: fresh.version }],
      () => store.saveText({ rootId: filesRoot, path: 'src/main.c', text: 'stale\n', version: fresh.version }));
    await recordFile('saveText', [{ rootId: filesRoot, path: 'new.md', text: 'new\n', version: null }],
      () => store.saveText({ rootId: filesRoot, path: 'new.md', text: 'new\n', version: null }));
    await recordFile('fileBytes', ['src/main.c'], () => readFile(path.join(tree, 'src', 'main.c'), 'utf8'));
    await recordFile('fileBytes', ['win.txt'], () => readFile(path.join(tree, 'win.txt'), 'utf8'));
    return { ops, readback, fileOps, tree: treeSpec };
  } finally {
    Date.now = realNow;
  }
}

async function schemaCases() {
  const { validateSchema } = await import('../server/store-client.mjs');
  const cases = [];
  const add = (name, schema, value) => cases.push({ name, schema, value, errors: validateSchema(schema, value) });
  add('type', { type: 'string' }, 42);
  add('type-union', { type: ['string', 'null'] }, 42);
  add('integer-vs-number', { type: 'integer' }, 1.5);
  add('const', { const: { a: 1 } }, { a: 2 });
  add('enum', { enum: ['a', 2, null] }, 'b');
  add('minLength', { minLength: 3 }, 'ab');
  add('maxLength', { maxLength: 2 }, 'abc');
  add('pattern', { pattern: '^[a-z]+$' }, 'ABC');
  add('minimum', { minimum: 3 }, 2);
  add('maximum', { maximum: 3 }, 4);
  add('minItems', { minItems: 2 }, [1]);
  add('maxItems', { maxItems: 1 }, [1, 2]);
  add('uniqueItems', { uniqueItems: true }, [{ a: 1 }, { a: 1 }]);
  add('required-and-unknown', { required: ['a', 'b'], properties: { a: { type: 'string' } }, additionalProperties: false }, { a: 1, c: 2 });
  add('additionalProperties-schema', { additionalProperties: { type: 'integer' } }, { a: 1, b: 'x' });
  add('prefixItems-then-items', { prefixItems: [{ type: 'string' }], items: { type: 'integer' } }, ['ok', 1, 'no']);
  add('ref', { $ref: '#/definitions/thing', definitions: { thing: { type: 'integer' } } }, 'x');
  add('allOf', { allOf: [{ type: 'string' }, { minLength: 3 }] }, 'ab');
  add('nested-order', { properties: { z: { type: 'integer' }, a: { type: 'integer' } }, required: ['m1', 'm2'] }, { z: 'no', a: 'no' });
  for (const contract of ['project-v1.schema.json', 'task-tests-v1.schema.json']) {
    const schema = JSON.parse(await readFile(path.join(ROOT, 'contracts', contract), 'utf8'));
    add(`contract-${contract}-empty`, schema, {});
    add(`contract-${contract}-garbage`, schema, { project: 42, tasks: 'no', version: 'v1' });
  }
  return cases;
}

/* The corpus builder, exported so F174's service harness replays the same recording through
   the client. The caller owns the directory's cleanup. */
export async function buildCorpusForImport(directory) {
  const captured = await capture(directory);
  return { ...captured, schema: await schemaCases() };
}


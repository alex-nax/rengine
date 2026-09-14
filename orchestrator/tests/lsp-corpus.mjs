/* The answers `runtime/lsp.mjs` gives, recorded before it is replaced (F161, charter D37, spec 102).
 *
 * Diagnostics are the one thing an agent and a person have to agree about: the editor pane and
 * `mcp__ide__getDiagnostics` read one store, so a file cannot be broken for one of them and fine
 * for the other. That is what this records — not the protocol, which the fake server already speaks
 * honestly, but what the CLIENT does with it: which servers a file is matched to, what is published,
 * what survives a crash, and what a caller is told when a declared server is not on the machine.
 *
 *   node orchestrator/tests/lsp-corpus.mjs > orchestrator/tests/lsp-corpus.json
 *
 * `runtime/lsp.mjs` is gone: `answers()` drives the CLIENT now, which is the client, the binary and
 * `red-lsp` together — one layer more than `lsp-parity` drives, and a regenerated record would be
 * judging the replacement against itself. Never regenerate.
 *
 * Two things are folded, because they are a machine's rather than a rule's: the temporary project
 * path, and the pid a spawn failure quotes. The RESTART WAIT is not folded — the first backoff is
 * 500 ms by rule, and a port that restarted eagerly would be a port that hammers a crashing server.
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const SERVER = path.resolve('orchestrator/tests/fake-language-server.mjs');
export const declare = (extra = {}) => [{
  id: 'fake', command: [process.execPath, SERVER, ...(extra.args ?? [])],
  match: extra.match ?? ['*.c', 'src/**/*.c'], languageId: 'c',
}];

const CODE = 'int main(void) {\n  // TODO one\n  return 0;\n}\n';
const CHANGED = '// TODO one\n// TODO two\n';

/* Each case drives the client through a sequence and records what it answers at each step. */
export const CASES = [
  ['a declared server is matched, started and read', { declared: 'default', steps: [
    { open: 'a.c', text: CODE, awaitItems: 1 },
    { read: 'a.c' },
    { open: 'a.c', text: CHANGED, awaitItems: 2 },
    { read: 'a.c' },
  ] }],
  ['a file no server declares is nobody’s business', { declared: 'default', steps: [
    { open: 'notes.txt', text: 'TODO' },
    { read: 'notes.txt' },
  ] }],
  ['a directory wildcard reaches a file directly inside it', { declared: 'default', steps: [
    { open: 'src/deep.c', text: CODE, awaitItems: 1 },
    { read: 'src/deep.c' },
  ] }],
  ['a server that is not on this machine is named', { declared: 'missing', steps: [
    { open: 'a.c', text: CODE },
    { awaitUnavailable: true },
    { read: 'a.c' },
  ] }],
  /* The server publishes and then exits. Its diagnostics go with it: keeping them would mean
     reporting a file as broken on the word of a process that is no longer running and may have been
     wrong when it died. So this never waits for the items — it waits for the absence. */
  ['a crash clears what the server said, and says when it will come back', { declared: 'crashing', steps: [
    { open: 'a.c', text: CODE },
    { awaitUnavailable: true },
    { read: 'a.c' },
  ] }],
  ['closing a file tells the server and drops what it said', { declared: 'default', steps: [
    { open: 'a.c', text: CODE, awaitItems: 1 },
    { close: 'a.c' },
    { read: 'a.c' },
  ] }],
];

const DECLARATIONS = {
  default: () => declare(),
  missing: () => [{ id: 'absent', command: ['definitely-not-a-language-server-9f'], match: ['*.c'], languageId: 'c' }],
  crashing: () => declare({ args: ['--crash-after', '1'] }),
};

const until = async (check, label) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
};

export async function answers() {
  const { LanguageServers, uriFor } = await import('../runtime/lsp-client.mjs');
  const recorded = {};
  for (const [name, options] of CASES) {
    const directory = await mkdtemp(path.join(tmpdir(), 'rengine-lsp-corpus-'));
    await mkdir(path.join(directory, 'src'), { recursive: true });
    const root = { id: 'r1', path: directory, name: 'project' };
    const servers = new LanguageServers(root, DECLARATIONS[options.declared]());
    const steps = [];
    try {
      for (const step of options.steps) {
        if (step.open) {
          const answer = await servers.open(path.join(directory, step.open), step.text);
          if (step.awaitItems) await until(async () => ((await servers.for(answer.uri)).length === step.awaitItems ? true : null), `${step.awaitItems} items`);
          steps.push({ opened: step.open, servers: answer.servers });
        } else if (step.close) {
          await servers.close(path.join(directory, step.close));
          steps.push({ closed: step.close });
        } else if (step.read) {
          steps.push({ read: step.read, items: await servers.for(uriFor(path.join(directory, step.read))) });
        } else if (step.awaitUnavailable) {
          const said = await until(async () => { const list = await servers.unavailable(); return list.length ? list : null; }, 'a named absence');
          steps.push({ unavailable: said.map(fold) });
        }
      }
      recorded[name] = { steps, unavailable: (await servers.unavailable()).map(fold) };
    } finally {
      await servers.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
  return recorded;
}

/* A spawn failure quotes the machine's own errno wording, and a crash quotes its exit code; the
   rule is the SHAPE of the sentence and the wait it names, which is what stays. */
const fold = said => said.replace(/\(code \d+\)/, '(code N)').replace(/\(.*ENOENT.*\)/, '(ENOENT)');

export const RECORDED = await (async () => {
  try { return JSON.parse(await readFile(new URL('./lsp-corpus.json', import.meta.url), 'utf8')); }
  catch { return null; }
})();

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.log(JSON.stringify(await answers(), null, 2));
}

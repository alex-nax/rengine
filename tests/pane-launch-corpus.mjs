/* What `agents/launch.mjs` hands a person's CLI, frozen before that module is deleted (F173, spec 146).
 *
 * The plan is already proved — `red-agents-launch.test.mjs` judges `launch_plan` against what
 * `config.mjs` composed, for every declared CLI. What has no record is the ACTING half: the
 * sentences printed into the pane, the argv and environment the CLI is actually spawned with, the
 * working directory it inherits, and the exit code that comes back out.
 *
 * So the CLI here is a fake that reports what it received, and the record is that report plus
 * everything the launcher said around it. Regenerate ONLY from a checkout where launch.mjs still
 * exists — that is, never again after the deletion commit. A replacement compared against a
 * regenerated record is judged against itself.
 *
 *   node tests/pane-launch-corpus.mjs > tests/pane-launch-corpus.json
 */
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_ID = '12345678-1234-1234-1234-123456789abc';

/* The identity an agent CLI stamps on its children. A pane must inherit NONE of it (KI-113), and
   "absent" is the assertion — so the record carries the NAMES that survived, which is empty when
   the rule holds and names the leak when it does not. Read from the registry, so this file names
   no CLI and one added as data is covered the day it is declared. */
export async function identityNames() {
  const { readFile } = await import('node:fs/promises');
  const registry = await readFile(path.join(ROOT, 'agents/registry.toml'), 'utf8');
  const names = new Set();
  let inside = false;
  for (const line of registry.split('\n')) {
    if (/^\[recipes\.[^\]]*\.identity\]/.test(line)) { inside = true; continue; }
    if (line.startsWith('[')) inside = false;
    if (inside && /^vars\s*=/.test(line)) for (const found of line.match(/"[^"]+"/g) ?? []) names.add(found.slice(1, -1));
  }
  return [...names];
}

/* The launch cases. Every declared CLI, because the argv a CLI is handed is its recipe's and the
   point of the record is that the Rust side reaches the same one — plus the two shapes that are
   about the LAUNCHER rather than about a CLI: extra arguments passed through, and a pane that has
   been told to report its conversation. */
export const CASES = [
  { name: 'claude', agent: 'claude' },
  { name: 'codex', agent: 'codex' },
  { name: 'kimi', agent: 'kimi' },
  { name: 'gemini', agent: 'gemini' },
  { name: 'opencode', agent: 'opencode' },
  { name: 'claude-extra-args', agent: 'claude', extra: ['--model', 'opus'] },
  { name: 'claude-reporting', agent: 'claude', session: '00000000-0000-0000-0000-0000000000a1' },
];

/* The values that are this run's rather than this launcher's decision. */
export const scrub = (value, places) => {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const [from, to] of places) if (from) text = text.replaceAll(from, to);
  text = text
    .replace(/rengine_[0-9a-f]{12}-[0-9a-f-]{36}/g, 'rengine_<root>-<mint>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/"label":"([a-z0-9-]+) [0-9a-f]{8}"/g, '"label":"$1 <short>"')
    .replace(/ [0-9a-f]{8}\b/g, ' <short>')
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<stamp>')
    /* The hook trust hash is taken over a command line that carries the per-launch mint, so it is a
       different value on every run — of the JavaScript as much as of the Rust. It is scrubbed for
       the same reason the mint is, and what proves it is still correct is `agent-config.test.mjs`,
       which computes it against the same command. */
    .replace(/sha256:[0-9a-f]{64}/g, '<hash>')
    /* The REASON a best-effort step failed is the transport's wording, not this launcher's
       decision: Node says "fetch failed" where Rust says something else, and what the record is
       for is that the step failed, said so, and did not take the launch down with it. */
    .replace(/(this pane holds): [^"\n]*/g, '$1: <reason>');
  return typeof value === 'string' ? text : JSON.parse(text);
};

/** A CLI that does nothing but say what it was given. */
async function fakeCli(directory) {
  const file = path.join(directory, 'fake-cli');
  await writeFile(file, `#!/bin/bash
printf 'FAKE_CLI_REPORT '
python3 - "$@" <<'PY'
import json, os, sys
print(json.dumps({
    "argv": sys.argv[1:],
    "cwd": os.getcwd(),
    "env": {k: v for k, v in os.environ.items() if k.startswith("RENGINE_")},
    "present": sorted(k for k in os.environ if k.startswith("CLAUDE") or k.startswith("CODEX_") or k == "CLAUDECODE"),
}, sort_keys=True))
PY
`);
  await chmod(file, 0o755);
  return file;
}

/** One launch through whichever launcher is named, recorded scrubbed. */
export async function recordLaunch(launcher, kase, directory) {
  const context = { url: 'http://127.0.0.1:1', token: 'a'.repeat(64), instance: ROOT_ID, rootId: ROOT_ID };
  const contextFile = path.join(directory, 'root-context.json');
  await writeFile(contextFile, JSON.stringify(context));
  const cli = await fakeCli(directory);
  const locks = path.join(directory, 'ide-locks');
  const home = path.join(directory, 'agent-home');
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: directory,
    RENGINE_IDE_DIRECTORY: locks,
    RENGINE_AGENT_HOME: home,
    ...(kase.session ? { RENGINE_ORCHESTRATOR_SESSION: kase.session } : {}),
    /* The identity a pane must NOT inherit, set on purpose so the record proves it was dropped. */
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: '00000000-0000-0000-0000-00000000beef',
  };
  let stdout = '', stderr = '', code = 0;
  try {
    const done = await run(launcher.command, [...launcher.args, kase.agent, cli, contextFile, ...(kase.extra ?? [])],
      { cwd: directory, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    stdout = done.stdout; stderr = done.stderr;
  } catch (error) {
    stdout = error.stdout ?? ''; stderr = error.stderr ?? String(error.message); code = error.code ?? 1;
  }
  const places = [[directory, '<dir>'], [home, '<home>'], [locks, '<locks>'], [cli, '<cli>'], [ROOT, '<root>']];
  const reported = stdout.match(/FAKE_CLI_REPORT (\{.*\})/);
  return {
    name: kase.name,
    code,
    /* What the launcher SAID, without the CLI's own report line. */
    said: scrub(stdout.replace(/FAKE_CLI_REPORT \{.*\}\n?/, ''), places).trimEnd().split('\n').filter(Boolean),
    stderr: scrub(stderr, places).trimEnd().split('\n').filter(Boolean),
    /* What the CLI actually got. */
    received: reported ? scrub(JSON.parse(reported[1]), places) : null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-pane-launch-'));
  try {
    const launcher = { command: process.execPath, args: [path.join(ROOT, 'agents/launch.mjs')] };
    const cases = [];
    for (const kase of CASES) cases.push(await recordLaunch(launcher, kase, directory));
    console.log(JSON.stringify({ identityNames: await identityNames(), cases }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

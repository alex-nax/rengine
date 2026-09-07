import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { declaration } from './format-fixtures.mjs';

/* A stand-in for a project's own write tool (spec 103): it records the argv it was handed, brackets
   its work with start/end lines so an interleaved pair is visible in the log rather than inferred,
   sleeps for as long as the row asks, and then edits the inventory the way tools/features.py would.
   Slow on purpose: a write lock that is never contended proves nothing. */
const WRITER = `#!/usr/bin/env node
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

const log = path.join(process.cwd(), 'write-log.txt');
const document = JSON.parse(process.argv[2] ?? 'null');
if (!document || typeof document !== 'object') { console.error('the write command was handed no JSON row'); process.exit(2); }
await appendFile(log, \`argv \${JSON.stringify(process.argv.slice(2))}\\n\`);
await appendFile(log, \`start \${document.action} \${document.key ?? document.id ?? '?'}\\n\`);
if (Number.isSafeInteger(document.slowMs) && document.slowMs > 0) await delay(document.slowMs);
const file = path.join(process.cwd(), 'features.json');
const inventory = JSON.parse(await readFile(file, 'utf8'));
const id = Number(document.id ?? String(document.key ?? '').replace(/^F/, ''));
const existing = inventory.features.find(feature => feature.id === id);
if (document.action === 'update') {
  if (!existing) { console.error(\`no feature \${id}\`); process.exit(3); }
  Object.assign(existing, { description: document.description ?? existing.description, passes: document.passes ?? existing.passes });
} else {
  inventory.features.push({ id, description: document.description ?? '', priority: document.priority ?? 'medium',
    acceptance_criteria: document.acceptance_criteria ?? [], dependencies: [], passes: false,
    ...(document.parent === undefined ? {} : { parent: document.parent }) });
}
await writeFile(file, JSON.stringify(inventory, null, 2));
await appendFile(log, \`end \${document.action} \${document.key ?? document.id ?? '?'}\\n\`);
console.log(JSON.stringify({ wrote: id, action: document.action, parent: document.parent ?? null }));
`;

export const INVENTORY = {
  schema_version: 1,
  features: [
    { id: 1, description: 'The parent task', priority: 'high', milestone: 'M0', category: 'core',
      acceptance_criteria: ['The write runs the project’s own command', 'Nothing is edited by hand'], dependencies: [], passes: false },
    { id: 2, description: 'A task that is done', priority: 'low', acceptance_criteria: [], dependencies: [1], passes: true },
  ],
};

export const taskDeclaration = (extra = {}) => ({
  ...declaration(), contract: 6, project: 'task-fixture',
  tracker: { provider: 'local', write: ['tools/write-task.mjs', '${json}'] },
  ...extra,
});

export async function taskProject(directory, name = 'project', document = taskDeclaration(), inventory = INVENTORY) {
  const root = path.join(directory, name);
  for (const sub of ['.rengine', 'tools']) await mkdir(path.join(root, sub), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document));
  await writeFile(path.join(root, 'features.json'), JSON.stringify(inventory, null, 2));
  await writeFile(path.join(root, 'tools/write-task.mjs'), WRITER);
  await chmod(path.join(root, 'tools/write-task.mjs'), 0o755);
  await writeFile(path.join(root, 'sample.pack'), Buffer.from('PACK\0{"entries":{}}', 'latin1'));
  return root;
}

export async function writeLog(root) {
  try { return (await readFile(path.join(root, 'write-log.txt'), 'utf8')).trim().split('\n').filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export const features = async root => JSON.parse(await readFile(path.join(root, 'features.json'), 'utf8')).features;

/* A CLI the launcher will find and run, in the managed place agent.sh looks first
   ($RENGINE_AGENT_HOME/<agent>/node_modules/.bin/<agent>), so a spawn reaches a real process and the
   argv it was actually started with is a file rather than an inference. */
export async function fakeCli(stateDirectory, agent) {
  const home = path.join(stateDirectory, 'agents', agent, 'node_modules/.bin');
  const argvFile = path.join(stateDirectory, `${agent}.argv`);
  await mkdir(home, { recursive: true });
  const executable = path.join(home, agent);
  /* Recorded as JSON, because a rendered prompt is many lines and a line-per-argument file could not
     say where one argument ended and the next began. */
  await writeFile(executable, `#!/usr/bin/env node\nimport { writeFile } from 'node:fs/promises';\n`
    + `await writeFile(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`
    /* Stays running the way a real CLI would, so the pane it was spawned into is a live agent
       session rather than one that exited before anything could list it. */
    + `setTimeout(() => {}, 120000);\n`);
  await chmod(executable, 0o755);
  return { executable, argvFile, read: async () => JSON.parse(await readFile(argvFile, 'utf8')) };
}

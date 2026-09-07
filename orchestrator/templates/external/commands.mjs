import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const scripts = new Set(['dev', 'lint', 'typecheck', 'test', 'build', 'docs:dev']);
const manifest = async () => JSON.parse(await readFile('package.json', 'utf8'));
const [action, file] = process.argv.slice(2);
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'inherit', shell: false });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}
try {
  if (action === 'json') {
    if (!file) throw new Error('JSON preview requires a file.');
    console.log(JSON.stringify(JSON.parse(await readFile(file, 'utf8')), null, 2));
  } else if (action === 'status') {
    console.log(`Project: ${process.cwd()}`);
    await run('git', ['--no-optional-locks', 'status', '--short', '--branch']);
  } else if (action === 'scripts') {
    const data = await manifest();
    console.log(`${data.name ?? 'Project'} — ${data.packageManager ?? 'package manager not declared'}`);
    for (const [name, command] of Object.entries(data.scripts ?? {})) console.log(`${name}\n  ${command}`);
  } else if (scripts.has(action)) {
    const data = await manifest();
    if (!data.scripts?.[action]) throw new Error(`package.json does not declare ${action}.`);
    console.log(`Project: ${process.cwd()}\nRunning: pnpm run ${action}`);
    await run('pnpm', ['run', action]);
  } else throw new Error(`Unknown external action: ${action ?? '(missing)'}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }

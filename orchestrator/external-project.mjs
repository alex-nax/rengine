import { mkdir, readFile, writeFile, realpath, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSchema } from './server/schema.mjs';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const within = (root, file) => { const rel = path.relative(root, file); return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };

async function canonicalDestination(filename) {
  try { return await realpath(filename); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await canonicalDestination(path.dirname(filename)), path.basename(filename));
  }
}

export async function installExternalProject(options) {
  for (const name of ['project', 'profile', 'launcher', 'state']) {
    if (typeof options[name] !== 'string' || !path.isAbsolute(options[name])) throw new Error(`--${name} requires an absolute path.`);
  }
  const project = await realpath(options.project);
  if (!(await stat(project)).isDirectory()) throw new Error('Project must be a directory.');
  const destinations = {};
  for (const name of ['profile', 'launcher', 'state']) {
    destinations[name] = await canonicalDestination(options[name]);
    if (within(project, destinations[name])) throw new Error(`--${name} must be outside the project.`);
  }
  const { profile, launcher, state } = destinations;
  const helper = path.join(profile, 'commands.mjs'), declarationFile = path.join(profile, 'project.json');
  if ([helper, declarationFile].includes(launcher)) throw new Error('Launcher must have its own path.');
  const node = process.execPath;
  const title = options.title ?? path.basename(project);
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
  const action = (id, title, tools = []) => ({ id: id.replaceAll(':', '-'), title, kind: 'log', command: [node, helper, id], requires: ['package.json'], tools });
  const groups = [{ id: 'project', title: 'Project', actions: [action('status', 'Project status', ['git']), action('scripts', 'Package scripts')] }];
  if (!options.minimal) {
    const controls = [['dev', 'Start development'], ['docs:dev', 'Start documentation'], ['lint', 'Lint'], ['typecheck', 'Typecheck'], ['test', 'Tests'], ['build', 'Build']]
      .filter(([id]) => manifest.scripts?.[id]).map(([id, name]) => action(id, name, ['pnpm']));
    if (controls.length) groups.push({ id: 'development', title: 'Development and checks', actions: controls });
  }
  const declaration = { contract: 5, project: path.basename(project).toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '') || 'external-project',
    title, icon: { glyph: title.slice(0, 2), token: 'info' },
    formats: [{ id: 'json', title: 'JSON', match: ['*.json'], modes: ['text', 'raw', 'preview'], default: 'text',
      preview: { kind: 'text', command: [node, helper, 'json', '${file}'], timeoutMs: 10000, maxBytes: 4194304 } }],
    dashboard: { title, groups } };
  const schema = JSON.parse(await readFile(new URL('../contracts/project-v1.schema.json', import.meta.url), 'utf8'));
  const errors = validateSchema(schema, declaration);
  if (errors.length) throw new Error(errors.join('; '));
  const script = `#!/bin/bash\nset -euo pipefail\nexport PATH=${quote(process.env.PATH ?? path.dirname(node))}\nagent_flags=(--no-agent)\nfor argument in "$@"; do\n  case "$argument" in\n    --agent|--handoff) agent_flags=() ;;\n    --project|--declaration|--state) echo 'This launcher is bound to its installed project and state.' >&2; exit 2 ;;\n  esac\ndone\nexec ${quote(node)} ${quote(path.join(checkout, 'orchestrator/launch.mjs'))} --project ${quote(project)} --declaration ${quote(declarationFile)} --state ${quote(state)} "\${agent_flags[@]}" "$@"\n`;
  const files = [[helper, await readFile(new URL('./templates/external/commands.mjs', import.meta.url), 'utf8'), 0o644],
    [declarationFile, `${JSON.stringify(declaration, null, 2)}\n`, 0o644], [launcher, script, 0o755]];
  for (const [filename, content] of files) {
    const resolved = await canonicalDestination(filename);
    if (within(project, resolved)) throw new Error(`Install file must be outside the project: ${filename}`);
    try { if (await readFile(filename, 'utf8') !== content) throw new Error(`Refusing to overwrite differing file: ${filename}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!options.dryRun) {
    for (const [filename, content, mode] of files) {
      await mkdir(path.dirname(filename), { recursive: true });
      try { await writeFile(filename, content, { flag: 'wx', mode }); }
      catch (error) {
        if (error.code !== 'EEXIST' || await readFile(filename, 'utf8') !== content) throw error;
      }
      if (mode === 0o755) await chmod(filename, mode);
    }
  }
  return { project, declarationFile, launcher, state, files: files.map(([filename]) => filename), dryRun: !!options.dryRun };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i++) {
      const flag = process.argv[i];
      if (['--project', '--profile', '--launcher', '--state', '--title'].includes(flag)) {
        if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`);
        options[flag.slice(2)] = process.argv[++i];
      } else if (flag === '--minimal') options.minimal = true;
      else if (flag === '--dry-run') options.dryRun = true;
      else if (flag === '--help') {
        console.log('node orchestrator/external-project.mjs --project DIR --profile DIR --launcher FILE --state DIR [--title NAME] [--minimal] [--dry-run]');
        process.exit(0);
      } else throw new Error(`Unknown option: ${flag}`);
    }
    console.log(JSON.stringify(await installExternalProject(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

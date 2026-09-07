import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSidecar, request } from './launcher/sidecar.mjs';
import { readHandoff, checkResume } from './agents/handoff.mjs';
import { bashPath, shellEnvironment } from './server/sessions.mjs';

const options = { state: path.join(homedir(), '.local/state/rengine'), agent: undefined };
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (['--project', '--state', '--agent', '--handoff', '--declaration'].includes(flag)) {
    if (!process.argv[index + 1]) throw new Error(`Missing value for ${flag}`);
    options[flag.slice(2)] = process.argv[++index];
  } else if (flag === '--no-agent') options.noAgent = true;
  else if (flag === '--launch-game') options.launchGame = true;
  else if (flag === '--inspect-ui') options.inspectUI = true;
  else if (flag === '--help') {
    console.log('npm start -- [--project DIR] [--declaration FILE] [--agent codex|claude|gemini|opencode|EXEC] [--state DIR] [--no-agent] [--launch-game] [--handoff FILE] [--inspect-ui]\n--declaration binds an external project.json without writing inside the project.\n--handoff resumes an explicit Codex conversation once its native pane is presented.\n--launch-game requires an explicit --project. --inspect-ui enables native stdin automation.\nCmd/Ctrl+Shift+R saves, rebuilds and reloads the desktop, retaining sessions.\nThe C/microui desktop detaches on exit; manage retained processes in Sessions.');
    process.exit(0);
  } else throw new Error(`Unknown option: ${flag}`);
}
if (options.handoff) {
  if (options.noAgent || (options.agent !== undefined && options.agent !== 'codex')) throw new Error('--handoff requires Codex and cannot use --no-agent.');
  const handoff = await readHandoff(options.handoff, options.project && path.resolve(options.project));
  options.project = handoff.project; options.agent = 'codex'; options.handoff = handoff.filename;
  await checkResume(bashPath(), handoff.project, shellEnvironment({ RENGINE_AGENT_HOME: path.join(path.resolve(options.state), 'agents') }));
}
if (options.launchGame && !options.project) throw new Error('--launch-game requires --project DIR.');
if (options.declaration && !options.project) throw new Error('--declaration requires --project DIR.');

await import('./build.mjs');
const instance = await ensureSidecar(path.resolve(options.state));
const query = new URLSearchParams();
if (options.project) {
  const state = await request(instance, 'state');
  if (options.declaration && state.capabilities?.externalDeclarations !== 1) throw new Error('This retained session host predates external declarations. Use a separate --state directory; no sessions were started.');
  const root = await request(instance, 'roots', { path: path.resolve(options.project),
    ...(options.declaration ? { declarationFile: path.resolve(options.declaration) } : {}) });
  if (options.handoff && state.capabilities?.handoff !== 1) throw new Error('This retained sidecar predates handoff support. Use a new --state directory, or explicitly stop its sessions and service before restarting it.');
  query.set('root', root.id);
  if (options.launchGame && !state.sessions.some(session => session.rootId === root.id && session.type === 'game' && session.state === 'running')) {
    const game = await request(instance, `game-config?${new URLSearchParams({ rootId: root.id })}`);
    if (!game.ready) throw new Error(game.issues.join('\n'));
  }
  let terminal = state.sessions.find(session => session.rootId === root.id && session.type === 'terminal' && session.state === 'running');
  terminal ??= await request(instance, 'terminal', { rootId: root.id });
  query.set('terminal', terminal.id);
  if (!options.noAgent) {
    const agent = options.agent ?? state.preferences.agent ?? '';
    if (options.agent !== undefined) await request(instance, 'preferences', { agent });
    let session = !options.handoff && state.sessions.find(session => session.rootId === root.id && session.type === 'agent' && session.state === 'running' && session.agent === agent && !session.handoff);
    if (!session) session = await request(instance, 'terminal', { rootId: root.id, type: 'agent', agent, action: agent ? 'launch' : 'menu', handoffFile: options.handoff });
    query.set('agent', session.id);
  }
  if (options.launchGame) query.set('game', (await request(instance, 'game', { rootId: root.id })).id);
}
const env = { ...process.env, RENGINE_WORKSPACE_URL: instance.url, RENGINE_WORKSPACE_TOKEN: instance.token,
  RENGINE_INITIAL_ROOT: query.get('root') ?? '', RENGINE_INITIAL_TERMINAL: query.get('terminal') ?? '',
  RENGINE_INITIAL_AGENT: query.get('agent') ?? '', RENGINE_INITIAL_GAME: query.get('game') ?? '',
  RENGINE_CAN_RELOAD: '1', ...(options.handoff ? { RENGINE_RESUME_AGENT: '1' } : {}) };
const binary = process.env.RENGINE_NATIVE_BINARY ?? fileURLToPath(new URL(
  process.platform === 'win32' ? '../.cache/desktop/bin/Release/rengine.exe' : '../.cache/desktop/bin/rengine', import.meta.url));
// Opt-in local stdin inspection — see sidecar: explicit-ui-inspection.
const desktopArgs = options.inspectUI ? ['--automation'] : [];
async function run(executable, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', env: environment });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
}
while (true) {
  const code = await run(binary, desktopArgs, env);
  if (code !== 75) { process.exitCode = code; break; }
  console.log('Rebuilding rEngine; agent and other sessions remain in the sidecar.');
  const built = await run(process.execPath, [fileURLToPath(new URL('./build.mjs', import.meta.url))]);
  if (built) { console.error('Reload build failed. Fix the build and run the same launch command to reattach retained sessions.'); process.exitCode = built; break; }
}

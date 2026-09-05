import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSidecar, request } from './launcher/sidecar.mjs';

const options = { state: path.join(homedir(), '.local/state/rengine'), agent: undefined };
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (['--project', '--state', '--agent'].includes(flag)) {
    if (!process.argv[index + 1]) throw new Error(`Missing value for ${flag}`);
    options[flag.slice(2)] = process.argv[++index];
  } else if (flag === '--no-agent') options.noAgent = true;
  else if (flag === '--launch-game') options.launchGame = true;
  else if (flag === '--inspect-ui') options.inspectUI = true;
  else if (flag === '--help') {
    console.log('npm start -- [--project DIR] [--agent codex|claude|gemini|opencode|EXEC] [--state DIR] [--no-agent] [--launch-game] [--inspect-ui]\n--launch-game requires an explicit --project. --inspect-ui enables native stdin automation.\nThe C/microui desktop detaches on exit; manage retained processes in Sessions.');
    process.exit(0);
  } else throw new Error(`Unknown option: ${flag}`);
}
if (options.launchGame && !options.project) throw new Error('--launch-game requires --project DIR.');

await import('./build.mjs');
const instance = await ensureSidecar(path.resolve(options.state));
const query = new URLSearchParams();
if (options.project) {
  const root = await request(instance, 'roots', { path: path.resolve(options.project) });
  const state = await request(instance, 'state');
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
    let session = state.sessions.find(session => session.rootId === root.id && session.type === 'agent' && session.state === 'running' && session.agent === agent);
    session ??= await request(instance, 'terminal', { rootId: root.id, type: 'agent', agent, action: agent ? 'launch' : 'menu' });
    query.set('agent', session.id);
  }
  if (options.launchGame) query.set('game', (await request(instance, 'game', { rootId: root.id })).id);
}
const env = { ...process.env, RENGINE_WORKSPACE_URL: instance.url, RENGINE_WORKSPACE_TOKEN: instance.token,
  RENGINE_INITIAL_ROOT: query.get('root') ?? '', RENGINE_INITIAL_TERMINAL: query.get('terminal') ?? '',
  RENGINE_INITIAL_AGENT: query.get('agent') ?? '', RENGINE_INITIAL_GAME: query.get('game') ?? '' };
const binary = process.env.RENGINE_NATIVE_BINARY ?? fileURLToPath(new URL(
  process.platform === 'win32' ? '../.cache/desktop/bin/Release/rengine.exe' : '../.cache/desktop/bin/rengine', import.meta.url));
// Opt-in local stdin inspection — see sidecar: explicit-ui-inspection.
const desktopArgs = options.inspectUI ? ['--automation'] : [];
const desktop = spawn(binary, desktopArgs, { stdio: 'inherit', env });
desktop.on('error', error => { console.error(error.message); process.exitCode = 1; });
desktop.on('exit', code => { process.exitCode = code ?? 1; });

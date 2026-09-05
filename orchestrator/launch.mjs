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
  else if (flag === '--help') {
    console.log('npm start -- [--project DIR] [--agent codex|claude|gemini|opencode|EXEC] [--state DIR] [--no-agent]\nThe desktop detaches on exit; manage retained processes in Session browser.');
    process.exit(0);
  } else throw new Error(`Unknown option: ${flag}`);
}

await import('./build.mjs');
const instance = await ensureSidecar(path.resolve(options.state));
const query = new URLSearchParams();
if (options.project) {
  const root = await request(instance, 'roots', { path: path.resolve(options.project) });
  const state = await request(instance, 'state');
  query.set('root', root.id);
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
const { default: electron } = await import('electron');
const env = { ...process.env, RENGINE_UI_URL: `${instance.url}/?${query}#${instance.token}` };
delete env.ELECTRON_RUN_AS_NODE;
const desktop = spawn(electron, [fileURLToPath(new URL('./desktop/main.cjs', import.meta.url))], { stdio: 'inherit', env });
desktop.on('error', error => { console.error(error.message); process.exitCode = 1; });
desktop.on('exit', code => { process.exitCode = code ?? 1; });

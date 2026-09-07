import path from 'node:path';
import { alive, ensureSidecar, request } from './sidecar.mjs';

const HEARTBEAT = 1000;

// A headless host is the sidecar and nothing else — see sidecar: no-desktop-from-here.
export async function runHeadless({ state, project }) {
  const stateDir = path.resolve(state);
  const instance = await ensureSidecar(stateDir);
  const root = project === undefined ? undefined : await request(instance, 'roots', { path: path.resolve(project) });
  console.log(`rengine headless ready url=${instance.url} instance=${instance.instance} pid=${instance.pid} state=${stateDir} root=${root?.id ?? '-'}`);
  console.log(`Its token is in ${path.join(stateDir, 'sidecar.json')}; the bind is loopback, so reach it from another machine through your own tunnel. Stopping this process leaves the sidecar and its sessions running.`);
  await new Promise(resolve => {
    const stop = message => { clearInterval(timer); process.off('SIGINT', detach); process.off('SIGTERM', detach); console.log(message); resolve(); };
    const detach = () => stop(`rengine headless detaching; sidecar PID ${instance.pid} keeps its sessions.`);
    const timer = setInterval(() => {
      if (alive(instance.pid)) return;
      process.exitCode = 1;
      stop(`rengine headless stopped: sidecar PID ${instance.pid} exited. See ${path.join(stateDir, 'sidecar.log')}.`);
    }, HEARTBEAT);
    process.on('SIGINT', detach); process.on('SIGTERM', detach);
  });
}

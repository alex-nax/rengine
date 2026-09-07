/* Restart a workspace's update supervisor without touching its session host (spec 102, KI-066).
 *
 * The supervisor is the layer a layered update cannot replace: it *performs* updates, so its own
 * code — the IDE port it reserves, the routes it serves, the desktops it manages — changes only when
 * it restarts. That costs the managed desktop windows and nothing else: PTYs, agents and the store
 * belong to the session host, which this must never signal. `--replace-host` (spec 098) is the other
 * tool, for the other layer, and ends sessions on purpose.
 *
 * The new supervisor is started detached, reparented away from whatever ran this. The thing asking
 * for a restart is usually a pane inside the workspace being restarted, and a supervisor that stayed
 * a child of that pane would die with it.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProcesses, findSupervisors, findHost, stopProcess, portReleased } from './replace.mjs';

const checkout = fileURLToPath(new URL('../..', import.meta.url));
const LAUNCHER = path.join(checkout, 'orchestrator/launch.mjs');

/* Refused by name rather than signalled: a state directory's host and its supervisor are different
   processes, and the failure mode worth preventing is stopping the one that holds the sessions. */
export async function plan(stateDir, { processes, descriptor, alive, runtimeRoot } = {}) {
  const table = processes ?? await listProcesses();
  /* findHost throws, by name and without signalling anything, when the descriptor's PID is not this
     directory's session host. That refusal is more specific than anything here could say, so it is
     left to travel; only "there is no host at all" is answered as a plan. */
  const found = await findHost(stateDir, { processes: table,
    ...(descriptor !== undefined ? { descriptor } : {}), ...(alive ? { alive } : {}) });
  if (!found?.descriptor || found.stale || !found.process) {
    return { refusal: `No live session host serves ${stateDir}; there is no supervisor of its own to restart.` };
  }
  const host = { pid: found.descriptor.pid, instance: found.descriptor.instance };
  const supervisors = await findSupervisors(host.instance, table, runtimeRoot ? { runtimeRoot } : {});
  return { host, supervisors };
}

export async function restart(stateDir, options = {}) {
  const { spawnImpl = spawn, stop = stopProcess, released = portReleased, launch = true } = options;
  const { refusal, host, supervisors } = await plan(stateDir, options);
  if (refusal) throw new Error(refusal);

  const stopped = [];
  for (const supervisor of supervisors) {
    /* The desktops are this supervisor's children and go with it; naming them is the whole warning,
       because a person watching their editor vanish should find it predicted here. */
    const outcome = await stop(supervisor.pid);
    stopped.push({ ...outcome, url: supervisor.url, desktops: supervisor.children.length });
    if (supervisor.url) await released(supervisor.url).catch(() => {});
  }

  if (!launch) return { host: { pid: host.pid, instance: host.instance }, stopped, started: null };

  /* Detached, with its own process group and no inherited pipes: the pane that asked for this is
     inside the workspace being restarted, and a supervisor that stayed its child would die with it.
     The host is adopted rather than replaced — no --replace-host here, deliberately. */
  const child = spawnImpl(process.execPath, [LAUNCHER, '--state', stateDir, '--no-agent'],
    { cwd: checkout, detached: true, stdio: 'ignore' });
  child.unref();
  return { host: { pid: host.pid, instance: host.instance }, stopped, started: { pid: child.pid, command: `${LAUNCHER} --state ${stateDir} --no-agent` } };
}

export function describe(result) {
  const lines = [`Session host PID ${result.host.pid} (${result.host.instance}) was not signalled; its sessions are intact.`];
  if (!result.stopped.length) lines.push('No update supervisor was running for it.');
  for (const entry of result.stopped) {
    lines.push(`Supervisor PID ${entry.pid}: ${entry.outcome}${entry.desktops ? `, closing ${entry.desktops} managed desktop window(s)` : ''}.`);
  }
  if (result.started) lines.push(`Started detached: PID ${result.started.pid}. The desktop reopens on the layout the store kept.`);
  return lines.join('\n');
}

/* `--plan` reads and reports; without it the tool acts. One entry point rather than a caller that
   imports this module, because `process.argv[1]` is whatever the caller put there: a wrapper that
   passed this file's own path made the check below fire and print usage instead of doing its job. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--state');
  const stateDir = at >= 0 ? args[at + 1] : process.env.RENGINE_STATE_DIR;
  if (!stateDir) { console.error('Usage: restart-supervisor.mjs --state DIR [--plan | --stop-only]'); process.exit(2); }
  const resolved = path.resolve(stateDir);
  try {
    if (args.includes('--plan')) {
      const value = await plan(resolved);
      if (value.refusal) { console.error(value.refusal); process.exit(1); }
      console.log(`Session host PID ${value.host.pid} — NOT signalled, its sessions are kept.`);
      if (!value.supervisors.length) console.log('No update supervisor is running for it; a restart would simply start one.');
      for (const found of value.supervisors) {
        console.log(`Supervisor PID ${found.pid} at ${found.url}, with ${found.children.length} child process(es) that close with it.`);
      }
    } else {
      const value = await restart(resolved, { launch: !args.includes('--stop-only') });
      console.log(describe(value));
    }
  } catch (error) { console.error(error.message); process.exit(1); }
}

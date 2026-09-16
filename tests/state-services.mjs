/* The services a state directory keeps after its host is gone: its PTYs (charter D60), its
 * store (D61) and its token ledger (spec 132). In production that is the point — a replaced host finds its panes and its state
 * where it left them. In a suite it means a test that starts a REAL host, kills it, and deletes
 * its directory would leave a service holding a shell for a directory that no longer exists: the
 * PTY service never reaps while it holds a session, which is exactly the promise D60 makes.
 *
 * So a test that owns a state directory ends its services when it is done with them.
 */
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);

export async function endStateServices(stateDir) {
  for (const name of ['pty.json', 'store.json', 'token.json']) {
    try {
      const descriptor = JSON.parse(await readFile(path.join(stateDir, name), 'utf8'));
      if (Number.isSafeInteger(descriptor.pid)) { try { process.kill(descriptor.pid, 'SIGKILL'); } catch { /* already gone */ } }
    } catch { /* this directory never had one */ }
  }
  /* And the process table, because the descriptor is not the only way a service exists: one that
     lost the startup race, or whose descriptor was written after this ran, is invisible in the
     directory and still holds a port and a PTY. `pty-retention.test.mjs` counts services this way
     for the same reason. */
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,args=']);
    for (const line of stdout.split('\n')) {
      if (!/red-(pty|store|token)-serve/.test(line) || !line.includes(`--state ${stateDir}`)) continue;
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (Number.isSafeInteger(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  } catch { /* no ps on this platform; the descriptors were the main path anyway */ }
}

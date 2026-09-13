/* The services a state directory keeps after its host is gone: its PTYs (charter D60) and its
 * store (D61). In production that is the point — a replaced host finds its panes and its state
 * where it left them. In a suite it means a test that starts a REAL host, kills it, and deletes
 * its directory would leave a service holding a shell for a directory that no longer exists: the
 * PTY service never reaps while it holds a session, which is exactly the promise D60 makes.
 *
 * So a test that owns a state directory ends its services when it is done with them.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function endStateServices(stateDir) {
  for (const name of ['pty.json', 'store.json']) {
    try {
      const descriptor = JSON.parse(await readFile(path.join(stateDir, name), 'utf8'));
      if (Number.isSafeInteger(descriptor.pid)) { try { process.kill(descriptor.pid, 'SIGKILL'); } catch { /* already gone */ } }
    } catch { /* this directory never had one */ }
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readDeclaration } from './formats.mjs';
import { CONTRACTS } from './contract.mjs';
import { startServer } from './red-host-fixture.mjs';

const FORMAT = { id: 'text', title: 'Text', match: ['*.txt'], modes: ['raw'], default: 'raw' };
const base = tracker => ({ contract: 5, project: 'kohai', formats: [FORMAT], ...(tracker ? { tracker } : {}) });

async function project(directory, name, declaration, inventory) {
  const root = path.join(directory, name);
  await mkdir(path.join(root, '.rengine'), { recursive: true });
  if (declaration) await writeFile(path.join(root, '.rengine', 'project.json'), JSON.stringify(declaration));
  if (inventory) await writeFile(path.join(root, 'features.json'), JSON.stringify(inventory));
  return { id: name, path: root };
}
const read = async root => projectTracker(root, await readDeclaration(root));

const INVENTORY = {
  schema_version: 1, project: 'kohai', review_status: 'approved',
  features: [
    { id: 1, description: 'done', passes: true, dependencies: [], milestone: 'O1', category: 'workspace', priority: 'high',
      acceptance_criteria: ['the thing happens'], evidence: ['tests/thing.test.mjs: the thing happens'] },
    { id: 2, description: 'ready', passes: false, dependencies: [1], milestone: 'O1', category: 'workspace', priority: 'medium' },
    { id: 3, description: 'blocked', passes: false, dependencies: [2], milestone: 'O2', category: 'design', priority: 'low' },
  ],
};

/* F115 (spec 116). The inventory has always carried the evidence that backs a row — the test and
   what it proves — and localRows mapped criteria and dropped it, so nothing in the workspace could
   answer "what test backs this task". A remote provider answers with an empty list for the same
   reason it does for criteria: an issue body is prose, not an evidence list. */
/* What this file used to drive is recorded and compared elsewhere, which is what a corpus is for:
 *
 *   the local backend, the readiness it derives and the tests manifest joined onto it
 *     -> tracker-corpus.json, via tracker-record and tracker-parity (F153)
 *   the two remote providers, their four refusals, their filters and what each request carries
 *     -> tracker-remote-corpus.json, via tracker-remote-parity (F154)
 *   which key belongs to which provider
 *     -> declaration-fixtures.json
 *
 * What is left is the one thing none of those can say: that a running workspace ADVERTISES the
 * route and then answers it.
 */
test('a workspace that serves the tracker route says so in its capabilities', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rengine-tracker-capability-'));
  let server;
  try {
    const root = await project(directory, 'p', base({ provider: 'local' }), INVENTORY);
    server = await startServer({ stateDir: path.join(directory, 'state') });
    const added = await server.store.addRoot(root.path);
    const get = async route => {
      const response = await fetch(server.url + route, { headers: { Authorization: `Bearer ${server.token}` } });
      return [response.status, await response.json()];
    };
    const [stateStatus, state] = await get('/api/state');
    assert.equal(stateStatus, 200);
    assert.equal(state.capabilities.tracker, 1, `the tracker capability is advertised: ${JSON.stringify(state.capabilities)}`);
    const [trackerStatus, tracker] = await get(`/api/tracker?rootId=${added.id}`);
    assert.equal(trackerStatus, 200, 'and the route it advertises answers');
    assert.equal(tracker.provider, 'local');
    assert.equal(tracker.rows.length, 3);
  } finally {
    if (server) await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

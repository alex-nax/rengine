import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { declaration } from './format-fixtures.mjs';

// Shared fixtures for the contract-4 devices array. Every probe is a small local script, so no test
// depends on a real headset, a reachable SSH host or any machine but the one running the suite.
export const SERIAL = 'RENGINE_FIXTURE_SERIAL';
export const HOST = 'RENGINE_FIXTURE_HOST';

export const thisMachine = (extra = {}) => ({ id: 'local', kind: 'local', title: 'This machine', ...extra });
export const answering = (extra = {}) => ({ id: 'answering-box', kind: 'ssh', title: 'Answering box', probe: ['tools/probe-ok.sh'], ...extra });
export const silent = (extra = {}) => ({ id: 'silent-box', kind: 'ssh', title: 'Silent box', probe: ['tools/probe-fail.sh'], ...extra });
export const stalling = (extra = {}) => ({ id: 'stalling-box', kind: 'ssh', title: 'Stalling box', probe: ['tools/probe-hang.sh'], probeTimeoutMs: 400, ...extra });
export const counted = (extra = {}) => ({ id: 'counted-box', kind: 'ssh', title: 'Counted box', probe: ['tools/probe-count.sh'], ...extra });
export const headset = (extra = {}) => ({
  id: 'headset', kind: 'adb', title: 'Fixture headset', selector: { env: SERIAL },
  probe: ['tools/probe-echo.sh', '-s', '${selector}', 'get-state'], ...extra,
});
export const remoteHost = (extra = {}) => ({
  id: 'remote-box', kind: 'ssh', title: 'Remote box', host: { env: HOST },
  probe: ['tools/probe-echo.sh', '${host}', 'true'], ...extra,
});
export const gated = (extra = {}) => ({
  id: 'gated-box', kind: 'ssh', title: 'Gated box', requires: ['config/host.env'], tools: ['definitely-missing-tool-9f'],
  probe: ['tools/probe-count.sh'], ...extra,
});

export const devicesDeclaration = (devices, base = declaration()) => ({ ...base, contract: 4, devices });
/* A record whose executable is deliberately also present on disk, so a test can prove the local
   stat did not happen rather than merely that it failed. */
export const remoteGame = (extra = {}) => ({
  id: 'remote-target', title: 'Remote target', executable: ['build/present-locally'], device: 'answering-box', surface: 'external', ...extra,
});
export const localGame = (extra = {}) => ({ id: 'local-target', title: 'Local target', executable: ['build/never-built'], surface: 'external', ...extra });

const SCRIPTS = {
  'tools/probe-ok.sh': '#!/bin/bash\nexit 0\n',
  'tools/probe-fail.sh': '#!/bin/bash\necho "fixture: the box is not answering" >&2\necho "fixture: a second line nobody should see" >&2\nexit 7\n',
  'tools/probe-echo.sh': '#!/bin/bash\nprintf "%s\\n" "$*" >> probe-argv.txt\nexit 0\n',
  /* The backgrounded writer only survives if the timeout killed the direct child alone; a
     process-group kill takes it with the script. */
  'tools/probe-hang.sh': '#!/bin/bash\n( sleep 2; echo alive > probe-survivor.txt ) &\nsleep 30\n',
  'tools/probe-count.sh': '#!/bin/bash\nprintf "x" >> probe-count.txt\nexit 0\n',
};

export async function deviceProject(directory, name, document = devicesDeclaration([answering()])) {
  const root = path.join(directory, name);
  for (const sub of ['.rengine', 'tools', 'build', 'config', 'data']) await mkdir(path.join(root, sub), { recursive: true });
  await writeFile(path.join(root, '.rengine/project.json'), JSON.stringify(document));
  for (const [file, body] of Object.entries(SCRIPTS)) {
    await writeFile(path.join(root, file), body);
    await chmod(path.join(root, file), 0o755);
  }
  await writeFile(path.join(root, 'build/present-locally'), '#!/bin/bash\nexit 0\n');
  await chmod(path.join(root, 'build/present-locally'), 0o755);
  await writeFile(path.join(root, 'data/present.bin'), Buffer.from([1, 2, 3]));
  return root;
}

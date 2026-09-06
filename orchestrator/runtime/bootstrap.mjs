import path from 'node:path';
import { ensureRuntime } from './discovery.mjs';
import { request } from '../launcher/sidecar.mjs';

const index = process.argv.indexOf('--binary');
if (index < 0 || !process.argv[index + 1]) throw new Error('Native bootstrap requires its executable path.');
const host = { url: process.env.RENGINE_WORKSPACE_URL, token: process.env.RENGINE_WORKSPACE_TOKEN };
const url = new URL(host.url);
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !/^[0-9a-f]{64}$/.test(host.token)) throw new Error('Native bootstrap requires a local workspace capability.');
const state = await request(host, 'state'); host.instance = state.instance;
const initial = { root: process.env.RENGINE_INITIAL_ROOT, terminal: process.env.RENGINE_INITIAL_TERMINAL,
  agent: process.env.RENGINE_INITIAL_AGENT, game: process.env.RENGINE_INITIAL_GAME, resume: process.env.RENGINE_RESUME_AGENT === '1' };
if (!initial.root) initial.root = state.roots[0]?.id ?? '';
const runtime = await ensureRuntime(host, { binary: path.resolve(process.argv[index + 1]), initial });
console.log(`rEngine update supervisor ready (PID ${runtime.pid}); retained sessions are unchanged.`);

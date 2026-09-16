/* The pane's MCP endpoint, as a spec starts one (spec 146).
 *
 * It was `node orchestrator/agents/mcp.mjs`; it is `red-mcp --facade` now. One place knows that, so
 * a spec asserting about tools is not also asserting about how the server is started — and so the
 * switch was one edit rather than nine.
 */
import path from 'node:path';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The binary under test: the environment names one, then this checkout's release or debug build. */
export const facadeCommand = () => process.env.RENGINE_RED_MCP
  || ['release', 'debug'].map(profile => path.join(ROOT, 'red/target', profile, 'red-mcp')).find(candidate => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  })
  || path.join(ROOT, 'red/target/debug/red-mcp');

/** What a pane's mcp.json names: the facade, on this launch's context. */
export const facadeArgs = contextFile => ['--facade', '--context', contextFile];

/* The thin client of `red_project::declaration` and `red_project::preview` (F156, spec 129).
 *
 * What a project declares about itself, and what its own producer says about one of its files, are
 * one implementation now — `red/red-project/` — judged against the answers this module used to give
 * (`tests/preview-corpus.json`). A refusal comes back as `{error, status}` and is
 * thrown as the same `fail()` this module threw, so a route answers the status it always answered.
 *
 * `runCommand` went with the last thing that used it: a dashboard capture, which is
 * `red_project::capture` now. Nothing in this workspace spawns a project's command from JavaScript.
 */
import { askProject } from './project-client.mjs';

/* A root registered with a declaration file of its own is read from THAT file, not from the
   project's — an external declaration describes a project this workspace does not own. */
const declarationOf = root => (typeof root === 'object' && root.declarationFile !== undefined ? root.declarationFile : '');

export async function readDeclaration(root) {
  return askProject(['declaration', typeof root === 'string' ? root : root.path, declarationOf(root)]);
}

export async function listFormats(root) { return { rootId: root.id, ...await readDeclaration(root) }; }

/* The environment a declared command runs in is the SHELL's, and `red_project::command` composes it
   at the spawn — where this module composed it — rather than here. Composing it in the caller made
   the two halves of an availability check disagree: the board judged a `tools` entry against
   `process.env` and the route that ran the action judged it against a shell's PATH. */
export async function formatPreview(root, data) {
  return askProject(['preview', root.id, root.path, declarationOf(root)], JSON.stringify(data));
}

/* What git already knows about a root's repository (F190/F192, spec 134). Read-only, and grouped by
   the caller: the repository is a heading in the view and never a record in the store (D2). */
export async function projectWorktrees(root) {
  return askProject(['worktrees', typeof root === 'string' ? root : root.path]);
}

export async function readBytes(root, data) {
  return askProject(['bytes', root.id, root.path], JSON.stringify(data));
}

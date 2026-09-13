# `/api/image` is red-host's, and `images.mjs` is deleted (2026-09-14)

F156a (the first of F156's three modules), spec 129. **The first JavaScript module this epic
removes.**

## Why this one first

`images.mjs` was 37 lines behind a single GET, with no dependency on anything the door does not
already have: the store service resolves the path (and owns what "inside this root" means, symlinks
included), and the rest is reading a file and judging its header. It also carried the last use of the
`image-dimensions` npm package, which goes with it.

## What the route decides, and why each one matters

The bytes are handed back **verbatim** — nothing is transcoded — so every judgement is about whether
that is safe:

- inside the project root, which is the store's rule and is asked of the store rather than restated;
- a regular file, and one small enough to hold (8 MiB);
- **image data by signature**, because a `.png` that is markup is served to a viewer as whatever the
  viewer decides it is;
- a header this workspace can read, and dimensions within what a pane will try to draw — 8,192 per
  side, 16 megapixels — because a file that lies about its size is the case the limit exists for.

The header parsers are the four shapes the JS package read: PNG's IHDR, JPEG's start-of-frame (found
by walking the segment chain, not by scanning for a marker value that also appears inside
entropy-coded data), GIF's logical screen, and WebP's three container forms.

## The check

`orchestrator/tests/images.test.mjs` is unchanged in what it drives — two roots holding a file of the
same name, the escape and the symlink, and five refusals — because the spec always drove the route
over HTTP and the route is simply answered by a different process now. What it gained is **each
refusal's own words**: that is what tells "this is not an image" from "this is an image too big to
draw", and it is what makes the header read rather than the extension trusted.

| Sabotage | Observed |
| --- | --- |
| the signature is not checked, only the header | markup named `.png` refused as `Image header is invalid or unsupported.` instead of by its signature |
| the dimensions are taken on trust | a PNG claiming 8,193 pixels is served |
| the file size is not bounded before it is read | an 8 MiB + 1 file is read and answered |

Three unit tests in `images.rs` cover the header readers directly, including a PNG truncated before
IHDR and a RIFF container that is not WebP.

## Gates

`npm test` — **326 of 326**. `cargo test -p red-host` — 15 tests. The `image-dimensions` dependency
is out of `package.json`.

## Where the count is

JavaScript on the app path: **6,801 lines**, down from 6,845. `formats.mjs` (386) and
`recordings.mjs` (115) are the rest of F156; `tracker.mjs` (344), `tracker-auth.mjs` (232),
`tasks.mjs` (194), `games.mjs` (161), `devices.mjs` (166), `dashboard.mjs` (82) and their rule
modules are F153–F155. That is 1,866 lines behind fifteen routes, and it is where the total moves.

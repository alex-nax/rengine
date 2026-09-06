# Game-tab recording: a rolling buffer, committed segments, and an agent-readable manifest

Date: 2026-09-06. Owner direction, given directly: a game pane keeps a **rolling buffer** while it is
live; a **toggle on the game tab commits a segment**; committed segments go into a **list queryable
over MCP**. Both commit gestures are wanted — *commit the last N seconds from the ring*, because the
interesting moment is always just past, and *explicit start/stop* for a planned demonstration — and
both produce the **same artifact shape**.

This spec extends spec 078 (the game session and its `embedded` surface) and follows the capability
discipline spec 078 recorded as the layered-update asymmetry (see *Who serves what*).

## What a recording is, and what it is for

Two readers, one artifact:

- A **person** scrubbing a bug back to the moment it happened.
- An **agent** asked "why did the character's head render black at 00:42?", which cannot watch a
  video. For that reader a segment is only useful if the frames, the log lines and (when it exists)
  an audio transcript are **timestamped on one clock**, so a picture can be put beside the line the
  engine printed while it was on screen.

So a segment is a directory of **timestamped JPEG keyframes**, a **timestamped log slice** and a
**manifest** that indexes both on the same clock, with a reserved **audio slot**. The manifest is the
machine artifact; the keyframe strip is the human one.

## Decision 1 — the ring holds encoded keyframes, and the encoder is pinned stb

The ring cannot hold raw frames and the encoding choice cannot be deferred to commit time, because by
then the frames are gone. The arithmetic that settles it, at the surface protocol's own limit
(1280×720 RGBA, 3.69 MB a frame):

| ring content | rate | 120 s |
| --- | --- | --- |
| raw 1280×720 RGBA | 60 fps | ~26 GB |
| raw 640×360 RGBA | 10 fps | ~1.1 GB |
| deflate(raw 640×360 RGB) — `node:zlib`, no new dependency | 10 fps | ~400 MB |
| **JPEG 640×360, quality 70** | **10 fps** | **~60 MB** |

Only the last one is a ring anyone would leave on by default, so **frames are downscaled and JPEG
encoded as they arrive**, and the ring holds the encoded bytes.

`third_party/` had `stb_textedit.h` and `stb_truetype.h` but no image writer. **Decision: pin
`stb_image_write.h` from the stb revision already pinned** (`2c980bb59875b0d32144a71867fbdebb2f77cd20`)
into the existing `third_party/stb` entry of `third_party/sources.json`, with its SHA-256 beside the
two headers already there. This is the cheapest honest option: no new upstream, no new licence (the
vendored stb `LICENSE` — public domain / MIT — already covers it), no new package, and the same
convention every other pinned file follows. `stbi_write_jpg_to_func` encodes into memory, which is
what a ring needs; the file-writing entry points are never used.

Rejected alternatives, recorded so nobody re-opens them: an npm image encoder (a new runtime
dependency for one call, and the frames are not in a Node process at the point they must be
encoded — see decision 3); PNG through `node:zlib` (no new dependency, but 400 MB a ring, above);
and shelling out to `ffmpeg` (an unpinned external tool the boundaries forbid as a requirement).

**No video container is written in this slice.** MJPEG-in-AVI is writable without a dependency, but a
container this repository cannot decode in its own gates would be a claim of playability nobody here
verified — the AP-10 shape. The keyframe strip at the configured rate is the human artifact (any
image viewer, Quick Look, rEngine's own image route, which already serves JPEG). A person who wants a
file can run, outside rEngine and against artifacts it already wrote:

```
ffmpeg -framerate 10 -pattern_type glob -i '.cache/recordings/<id>/keyframes/*.jpg' -c:v libx264 out.mp4
```

That command is documentation, not a dependency, and nothing in rEngine runs it.

## Decision 2 — one clock, and it is the pane's own

Every keyframe already arrives stamped: the surface protocol carries a frame `sequence` and
`game.c` keeps it (`g->sequence`). The recorder adds `atMs`, milliseconds since the segment's first
kept keyframe, and a wall-clock ISO timestamp, to **every** keyframe and **every** log line. The
three numbers answer three different questions and all three are kept:

- `atMs` — position inside the segment, the axis a person scrubs and an agent correlates on.
- `sequence` — the game's own frame number, the only value that ties a keyframe back to the game's
  internal ordering and to anything else stamped with it.
- `wall` — the absolute instant, the only value that lines a segment up with an artifact rEngine did
  not write (a capture-mcp transcript, a crash report, another machine's log).

A log line is stamped **when its terminating newline arrives at the desktop**, on the same
`SDL_GetTicks64` clock as the frames, not when the game wrote it. That is a real and stated
approximation: the line's true origin is inside the game's own buffering. It is honest to within the
PTY's flush latency, and it is the only clock available to a reader that never sees the game's
internal one.

## Decision 3 — the ring lives in the desktop, the read routes live in the worker

Two of the three streams already pass through the native desktop: **frames** arrive per-frame on the
`/surface` socket into the game pane, and the **session output** arrives on the `/events` socket
(and the session host retains a bounded copy besides). So this feature writes down streams the
desktop already handles rather than capturing anything new.

The ring is therefore **in the desktop** (`orchestrator/native/recording.c`), and that placement is
forced as well as convenient:

- The encoder is a C header. A Node-side ring would need an image encoder Node does not have
  (decision 1), and the frames would have to be encoded in the session host — the one process a
  layered update cannot replace.
- Spec 078's lesson, recorded as KI-043: **a capability only the retained session host serves cannot
  be delivered by a layered update.** A ring in the host would be undeliverable to a live workspace
  without quiescence, which stops every retained PTY.
- The toggle is a control on the game tab, which is desktop code either way.

Reading segments back is pure filesystem work over a project root, so it goes where spec 078 put
preflight: **the replaceable workspace worker serves `GET /api/recordings` and `GET /api/recording`
from its own checkout and advertises `recordings: 1`**, and the session host serves the same two
routes from the same module and advertises the same flag, so a workspace that never grew a worker
answers identically. Nothing about recording is forwarded, so nothing about it depends on the host's
age. The MCP tools gate on `recordings: 1` and name the real remedy — *update the workspace layer* —
which is, this time, actually the remedy.

The desktop writes the files; no route uploads them. A 60 MB segment through an HTTP body to a
service running on the same machine, to be written to a directory the desktop can already write to,
would buy nothing.

`supervisor.mjs` needs no change: its worker path passes the worker's capability set through, and its
`workspaceWorkerUnavailable` fallback must **not** add `recordings` — that fallback reads host state
and may only claim what the supervisor itself serves. Adding it there would be exactly the mistake
spec 078 records.

## Decision 4 — audio is a declared slot, not a second audio stack

The owner asked for video **and audio** and logs. rEngine cannot recover the audio: the game's sound
goes to the system output device through its own audio API and never passes through the workspace,
which sees only a frame socket and a PTY. Per-app audio needs an OS capture path — on macOS,
ScreenCaptureKit — plus an ASR backend to make it readable, and `/Users/alex/capture` (capture-mcp)
**already does exactly that**: per-app audio, chunked, timestamped and transcribed by a pluggable
backend, beside window video and the process's stdout/stderr.

Building a second one here is out of the question. Driving that one from inside rEngine is also
rejected **for this slice**, on the repository's own boundaries: it would make an unpinned tool at a
`~/...` path a runtime requirement of the desktop, and it would need microphone/screen-recording
consent granted to rEngine rather than to the tool the owner already trusts with it.

**Decision: land video and logs completely, and carry an explicit `audio` slot in the manifest** that
says it is absent, why, and which tool is the intended provider:

```json
"audio": { "present": false, "provider": "capture-mcp",
           "reason": "The game's audio goes to the system output device and never passes through the workspace; per-app audio capture and transcription belong to capture-mcp (KI-044).",
           "issue": "KI-044" }
```

The slot is data, not a code stub: no branch pretends to fill it, `recording_read` reports it
verbatim, and a reader is told in one field that audio is missing and where it will come from. The
integration — a declared, optional per-project audio provider that a segment commit invokes for its
window, whose timestamped transcript chunks land beside the keyframes on the same clock — is
**KI-044** and its own spec. Audio is not silently dropped and it is not half-built.

## The ring

One recorder per **embedded** game tab, created when the tab has a live surface and destroyed with
the tab. An `external` game has no frame stream at all (spec 078: rEngine retains only its PTY
output), so it gets no recording control in this slice; recording an operating-system window is the
same problem as audio and belongs to the same tool (KI-044).

**Bounds are explicit and both apply, whichever binds first.** Defaults:

| bound | default | range |
| --- | --- | --- |
| `seconds` | 120 | 5 – 900 |
| `bytes` | 64 MiB | 4 MiB – 1 GiB |
| `fps` | 10 | 1 – 30 |
| `width` | 640 | 160 – 1280 |
| `quality` | 70 | 30 – 95 |

They are read from the workspace preference `recording` (an object, validated in `store.mjs` like
every other preference and clamped again in the desktop, so a hand-edited workspace file cannot
produce a 4 GB ring). Height follows the source aspect ratio. A retained session host older than this
preference drops the key silently — so the desktop **shows the bound it actually applied** in the
recording row, and the effective numbers are also in every manifest's `ring` block. The effective
bound is never something a reader has to infer.

Eviction is from the oldest end, on both bounds, on every push. Log lines are bounded the same way
(the ring's seconds, plus a 2 MiB line budget) so a chatty game cannot displace the video budget.

The ring runs **whenever the pane is live** — that is the default the owner asked for. It is not
gated on the tab being visible or focused: frames arrive on the pane's own socket whether or not its
pane is on top, and a bug does not wait for the tab to be selected.

## The two gestures, and why they produce one artifact

- **Commit last N seconds** — writes the whole ring as a segment. `kind: "ring"`.
- **Record / Stop** — the toggle marks a start point and keeps recording; pressing it again stops and
  commits everything from that mark. `kind: "segment"`.

An explicit recording is **still stored in the same ring**, and that is deliberate: one storage, one
set of bounds, no second unbounded buffer that a forgotten toggle could grow until the disk fills. If
an explicit recording outruns the ring's bounds, the segment begins where the ring does and the
manifest says so — `"truncated": true` with `requestedStartMs` — rather than quietly starting late.

Committing is a **drain**, not a stall: the desktop writes a bounded number of keyframes per frame
(24, so a full 1,200-frame ring lands in about 50 frames — under a second — without a visible freeze)
and writes `manifest.json` **last**. A directory without a manifest is an incomplete commit and is
not listed. This is what makes an in-flight commit a real state, and:

- **When the game session exits**, an open explicit recording is committed rather than dropped, and
  the ring then stops sampling. The pane keeps its committed segments.
- **When the tab or the desktop closes**, a commit already in flight drains to completion
  synchronously (it is bounded by the ring, so it terminates) before the recorder is freed.

## Segment layout

Under the game's **project root**, in a directory that ignores itself:

```
<root>/.cache/recordings/.gitignore          # "*", written once
<root>/.cache/recordings/<id>/manifest.json  # written last; its presence means "complete"
<root>/.cache/recordings/<id>/keyframes.jsonl
<root>/.cache/recordings/<id>/keyframes/000001.jpg …
<root>/.cache/recordings/<id>/log.jsonl
```

`<id>` is `YYYYMMDDTHHMMSSZ-<6 hex>`: sortable, unique, and readable. Captures stay with the project
they came from. The self-ignoring `.gitignore` means a consumer whose own ignore rules do not cover
`.cache/` still never sees a keyframe offered for commit.

The per-frame and per-line indexes are JSONL rather than arrays inside the manifest, so the manifest
stays small enough to read whole (a 1,200-frame index would be ~110 KB of it) and both indexes stream.

`keyframes.jsonl`, one object per line:

```json
{"file":"keyframes/000001.jpg","atMs":0,"wall":"2026-09-06T20:45:12.340Z","sequence":41233,"bytes":42111}
```

`log.jsonl`, one object per line — the text is the PTY line with ANSI escape sequences, carriage
returns and other C0 controls removed, because a log slice is read as data. `atMs` is measured from
the **first keyframe**, so a line the game printed before the first frame of the segment carries a
negative `atMs`; that is kept rather than clamped, because "this was already on the way in" is
exactly what a reader correlating a crash with a picture needs to see:

```json
{"atMs":118,"wall":"2026-09-06T20:45:12.458Z","text":"LoadWorld Worlds\\t01s01"}
```

`manifest.json` (version 1):

```json
{
  "version": 1, "id": "20260906T204512Z-3f9a1c", "kind": "ring",
  "rootId": "…", "sessionId": "…", "game": "nolf-flat", "title": "NOLF (flat) · nolf-improved",
  "createdAt": "2026-09-06T20:47:31.002Z",
  "startedAt": "2026-09-06T20:45:12.340Z", "endedAt": "2026-09-06T20:47:12.290Z", "durationMs": 119950,
  "clock": { "unit": "ms", "field": "atMs", "origin": "startedAt",
             "note": "atMs, sequence and wall are on one clock across keyframes, log lines and any audio chunk." },
  "video": { "codec": "jpeg", "width": 640, "height": 360, "fps": 10, "quality": 70,
             "frames": 1200, "bytes": 58720256, "directory": "keyframes", "index": "keyframes.jsonl" },
  "log": { "file": "log.jsonl", "lines": 812, "bytes": 91234 },
  "audio": { "present": false, "provider": "capture-mcp", "reason": "…", "issue": "KI-044" },
  "ring": { "seconds": 120, "bytes": 67108864, "fps": 10, "width": 640, "quality": 70,
            "requestedSeconds": 120, "truncated": false, "droppedLeadMs": 0, "droppedFrames": 7 },
  "bytes": 58811490
}
```

## Routes, capability and tools

- `GET /api/recordings?rootId[&limit]` → `{ rootId, recordings: [ … ] }`, newest first, at most 200,
  each entry `{ id, game, sessionId, title, kind, startedAt, endedAt, durationMs, bytes, path,
  artifacts: { keyframes: { count, present }, log: { lines, present }, audio: { present, … } } }`.
  A directory without a manifest, or with one that is not valid JSON or not version 1, is reported as
  `{ id, error }` rather than dropped: a half-written or foreign directory is a fact about the store.
- `GET /api/recording?rootId&id[&artifact=manifest|log|keyframes|all][&offset][&limit][&maxCharacters]`
  → the manifest plus the requested readable parts: `log` returns the bounded tail of `log.jsonl`
  (default 8,000 characters, at most 32,000, mirroring `session_output`), `keyframes` returns a page
  of the index (default 200, at most 1,000) whose entries carry **root-relative paths**, so a
  keyframe is fetched by path the way every other asset in this workspace is.

Both are served by the worker from its own checkout and by the host from the same module
(`orchestrator/server/recordings.mjs`). Both advertise `recordings: 1`.

MCP (`mcp-worker.mjs`), both read-only, both gated by name:

- `recordings_list` — "List the game recordings committed for the bound project…"
- `recording_read` — "Read one committed recording: its manifest, a bounded slice of its timestamped
  log, and a page of its timestamped keyframe index with root-relative image paths. Keyframes, log
  lines and any audio chunk share one clock (atMs)…"

The guard message is *"This retained service predates game recording. Update the workspace layer
first."* — true, because the worker serves the routes itself.

## Native

The game tab's existing control row gains three cells, and only for an `embedded` surface. It stays
**one** row: a second row would move the game rectangle down and silently retarget every pointer
coordinate the existing game fixture clicks.

| control | role / key | behaviour |
| --- | --- | --- |
| `Record` / `Stop · 00:42` | `recording` / `toggle` | starts an explicit segment; pressing again stops and commits it |
| `Commit last 120 s` | `recording` / `commit` | commits the ring |
| status label | `recording` / `status` | the effective ring bound and its fill, the elapsed explicit time, the commit's progress, or the last segment's id and counts |

`re_app_inspect` reports the recorder on its game tab as `recording: { state, frames, bytes, spanMs,
logLines, segments, lastSegment, lastPath, ringSeconds, ringBytes, fps, width, pending, message }` —
what the ring holds, the bound it actually applied, and where the last segment went — so a fixture
can assert the ring without reading the disk, and then read the disk to check that what it holds is
what was written. The encoded `video.width`/`video.height` are the frame's own size when the surface
is smaller than the bound, never the bound itself.

Colours and row metrics come from `theme.json` (`metrics.recording`, `strings.recording`) through the
generated `RE_METRIC_*` / `RE_COLOR_*` constants, as `tools/design.py check` requires.

## Acceptance and verification

1. **Ring bounds and gestures (native CTest, `rengine_recording_test`, no window):** a ring pushed
   past its `seconds` bound keeps only the newest window; past its `bytes` bound the same; a
   commit-last-N writes `manifest.json`, `keyframes.jsonl`, `log.jsonl` and one JPEG per kept frame,
   every keyframe carrying `atMs`, `sequence` and `wall`, and `atMs` starting at 0 and rising;
   explicit start/stop produces the same artifact shape with `kind: "segment"`; an explicit
   recording that outruns the ring reports `truncated: true` with its `requestedStartMs`; a commit
   drains over several ticks and its manifest appears only at the end; a session exit during an open
   explicit recording commits it, and the stopped ring then keeps nothing further; a close during a
   drain finishes it; frames are sampled at the declared rate rather than the pane's; log lines are
   stripped of ANSI and stamped on the frame clock; the downscale flips the surface's bottom-up rows
   so the image is the right way up; encoded output starts with the JPEG signature. Each run works in
   its own tree and removes it, because the ids are deterministic and a leftover segment from an
   aborted run would otherwise answer an assertion about what this run wrote.
2. **Store and routes (service tests):** `listRecordings` orders newest first, bounds the listing,
   reports a manifest-less directory and a malformed manifest as `error` entries rather than dropping
   them, and never escapes the root; `readRecording` returns the manifest, a bounded log tail and a
   paged keyframe index with root-relative paths, and refuses an unknown id and a traversing id; the
   host advertises `recordings: 1` and serves both routes; the worker serves both **itself** above a
   proxy host that advertises only `handoff: 1` and still advertises `recordings: 1`; the supervisor
   fallback does not claim it; MCP discovery shows `recordings_list` and `recording_read` as
   read-only, they answer through the worker, and above a host without the capability they refuse by
   name with the workspace-layer remedy.
3. **The toggle (native fixture, `native-recording.spec.mjs`, in `test:desktop`):** a real
   `rengine_surface_fixture` game session streams real frames into a pane; the recording row appears
   with its controls; `recording`/`toggle` starts and the inspected state becomes `recording`;
   pressing it again commits, and the committed directory on disk carries a manifest whose keyframe
   count matches the inspected count, JPEG files that are JPEGs, and a log slice; `recording`/`commit`
   writes a second segment from the ring; `recordings_list` through the service then lists both.
4. `npm test`, `npm run test:desktop`, CTest in `.cache/desktop`, `./init.sh`,
   `python3 tools/features.py validate`, `python3 tools/design.py check` and sidecar validation pass;
   the native build has zero warnings.

Boundaries: no new npm dependency and no new C dependency beyond the pinned stb header already
sourced from the pinned stb revision; no game is named anywhere in this code; no video container and
no audio capture in this slice (KI-044); `external` game surfaces get no recording control; Windows
stays unqualified (KI-014); passing waits on the owner's live verification after a layered update, as
F71/F72/F74 do.

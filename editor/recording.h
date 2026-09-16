#ifndef RENGINE_RECORDING_H
#define RENGINE_RECORDING_H
#include "common.h"

/* Game-tab recording (spec 081): a rolling buffer of JPEG keyframes and timestamped log lines that a
 * toggle commits as a segment under <root>/.cache/recordings/<id>/. The ring holds encoded bytes
 * because raw frames cannot be afforded and the encoding cannot be deferred to commit time. */

struct ReApp;
typedef struct ReRecorder ReRecorder;

enum { RE_RECORDING_RING = 0, RE_RECORDING_ACTIVE, RE_RECORDING_COMMITTING, RE_RECORDING_STOPPED };
enum { RE_RECORDING_DRAIN = 24 };   /* keyframes written per tick: a full ring lands in under a second */

typedef struct { int seconds, bytes, fps, width, quality; } ReRecordBounds;

/* What the recorder announces on the live channel (spec 095): an explicit start, and every commit.
 * The recorder carries its own identity, so one callback serves every tab. `kind` is the wire's
 * vocabulary — "ring" or "explicit" — not the manifest's, which calls the second one "segment". */
typedef struct {
  const char *root_id, *session_id, *game_id;
  const char *event;         /* "started" or "committed" */
  const char *recording_id;  /* the segment directory name, minted when the segment begins */
  const char *kind;          /* "ring" or "explicit" */
} ReRecordEvent;
typedef void (*ReRecordAnnounce)(void *user, const ReRecordEvent *event);

typedef struct {
  const char *root_path, *root_id, *session_id, *game_id, *title;
  ReRecordBounds bounds;
  Uint64 now_ms;        /* the monotonic clock at open; every atMs is measured from it */
  long long wall_ms;    /* epoch milliseconds at open, so wall clock is derived, not sampled */
  ReRecordAnnounce announce; void *announce_user;   /* optional; a NULL announces nothing */
} ReRecordOpen;

/* Epoch milliseconds as the ISO instant every keyframe, log line and manifest is stamped with. */
void re_recording_wall_iso(long long epoch_ms, char *out, size_t size);

/* Defaults, then the declared preference clamped into range; a hand-edited workspace cannot ask for
 * a ring larger than the bound this returns. `preferences` may be NULL. */
ReRecordBounds re_recording_bounds(const cJSON *preferences);

ReRecorder *re_recording_open(const ReRecordOpen *options);
void re_recording_close(ReRecorder *r);          /* drains a commit in flight, then frees */
void re_recording_frame(ReRecorder *r, const unsigned char *rgba, int width, int height, int sequence, Uint64 now_ms);
void re_recording_output(ReRecorder *r, const char *bytes, size_t size, Uint64 now_ms);
void re_recording_toggle(ReRecorder *r, Uint64 now_ms);       /* start an explicit segment, or stop and commit it */
void re_recording_commit_ring(ReRecorder *r, Uint64 now_ms);  /* commit the last N seconds the ring holds */
void re_recording_exited(ReRecorder *r, Uint64 now_ms);       /* the game session exited: commit, then stop */
void re_recording_tick(ReRecorder *r, Uint64 now_ms);         /* once a frame: writes the next slice of a commit */
int re_recording_state(const ReRecorder *r);
void re_recording_inspect(const ReRecorder *r, cJSON *out);   /* adds the "recording" object to `out` */

/* The game tab's control row: the toggle, the ring commit and the status label. */
void re_recording_ui(struct ReApp *app, mu_Context *ui, int tab);
/* Keeps one recorder per embedded game tab, and commits an open segment when its session exits. */
void re_recording_sync(struct ReApp *app);
/* Routes one session output event into the recorder of the tab bound to that session. */
void re_recording_output_event(struct ReApp *app, const cJSON *event);

/* Bottom-up RGBA (the surface protocol's own row order) to top-down RGB, box filtered. Exposed so
 * the orientation is checked where it is decided rather than through an image decoder. */
void re_recording_downscale(const unsigned char *src, int sw, int sh, unsigned char *dst, int dw, int dh);
#endif

#include "app.h"
#include "jpeg.h"
#include "ui/ui.h"
#include <time.h>

#include <sys/stat.h>
#ifdef _WIN32
#include <direct.h>
#define re_make_dir(path) _mkdir(path)
#else
#define re_make_dir(path) mkdir((path), 0755)
#endif

enum { RE_KIND_RING = 0, RE_KIND_SEGMENT };
enum { LINE_LIMIT = 2048, LINE_BYTES = 2 * 1024 * 1024, LINE_SLOTS = 4096, FRAME_SLOTS = 4096 };
enum { SANE_TEXT = 0, SANE_ESC, SANE_CSI, SANE_OSC, SANE_OSC_ESC };

typedef struct { unsigned char *bytes; size_t size; int sequence, refs; Uint64 at; } ReFrame;
typedef struct { Uint64 at; char *text; } ReLine;

typedef struct {
  bool active; int kind, written, count, after;
  ReFrame **frames;
  char id[64], directory[2048];
  FILE *index;
  Uint64 from; int requested_seconds; bool truncated; Uint64 dropped_lead;
  int log_lines; size_t log_bytes, video_bytes;
} ReCommit;

struct ReRecorder {
  char root[1600], root_id[65], session[65], game[65], title[256];
  ReRecordBounds bounds;
  Uint64 base_ms; long long wall_base;
  ReFrame **ring; int capacity, first, count; size_t bytes;
  ReLine *lines; int line_capacity, line_first, line_count; size_t line_bytes;
  char partial[LINE_LIMIT + 1]; size_t partial_size; int sane;
  Uint64 last_sample, explicit_from; bool sampled;
  int state, segments, dropped, encoded_width, encoded_height;
  char last_segment[64], last_path[2100], message[256];
  char explicit_id[64];        /* minted when an explicit segment starts, so its start and its commit
                                  name one directory on the feed; cleared when that segment commits */
  ReRecordAnnounce announce; void *announce_user;
  ReCommit commit;
  unsigned char *scratch; size_t scratch_size;
};

static int clamp(int value, int low, int high) { return value < low ? low : value > high ? high : value; }

ReRecordBounds re_recording_bounds(const cJSON *preferences) {
  ReRecordBounds bounds = {120, 64 * 1024 * 1024, 10, 640, 70};
  const cJSON *declared = cJSON_GetObjectItemCaseSensitive(preferences, "recording");
  if (!cJSON_IsObject(declared)) return bounds;
  const cJSON *value;
  if (cJSON_IsNumber(value = cJSON_GetObjectItemCaseSensitive(declared, "seconds"))) bounds.seconds = clamp(value->valueint, 5, 900);
  if (cJSON_IsNumber(value = cJSON_GetObjectItemCaseSensitive(declared, "bytes"))) bounds.bytes = clamp(value->valueint, 4 * 1024 * 1024, 1024 * 1024 * 1024);
  if (cJSON_IsNumber(value = cJSON_GetObjectItemCaseSensitive(declared, "fps"))) bounds.fps = clamp(value->valueint, 1, 30);
  if (cJSON_IsNumber(value = cJSON_GetObjectItemCaseSensitive(declared, "width"))) bounds.width = clamp(value->valueint, 160, 1280);
  if (cJSON_IsNumber(value = cJSON_GetObjectItemCaseSensitive(declared, "quality"))) bounds.quality = clamp(value->valueint, 30, 95);
  return bounds;
}

void re_recording_downscale(const unsigned char *src, int sw, int sh, unsigned char *dst, int dw, int dh) {
  for (int y = 0; y < dh; y++) {
    int y0 = y * sh / dh, y1 = (y + 1) * sh / dh;
    if (y1 <= y0) y1 = y0 + 1;
    for (int x = 0; x < dw; x++) {
      int x0 = x * sw / dw, x1 = (x + 1) * sw / dw;
      if (x1 <= x0) x1 = x0 + 1;
      unsigned int r = 0, g = 0, b = 0, n = 0;
      for (int sy = y0; sy < y1 && sy < sh; sy++) {
        const unsigned char *row = src + (size_t)(sh - 1 - sy) * (size_t)sw * 4;   /* the surface streams bottom-up */
        for (int sx = x0; sx < x1 && sx < sw; sx++) { r += row[sx * 4]; g += row[sx * 4 + 1]; b += row[sx * 4 + 2]; n++; }
      }
      unsigned char *out = dst + ((size_t)y * dw + x) * 3;
      if (!n) { out[0] = out[1] = out[2] = 0; continue; }
      out[0] = (unsigned char)(r / n); out[1] = (unsigned char)(g / n); out[2] = (unsigned char)(b / n);
    }
  }
}

static void frame_unref(ReFrame *f) { if (f && --f->refs <= 0) { free(f->bytes); free(f); } }
static ReFrame *ring_at(const ReRecorder *r, int index) { return r->ring[(r->first + index) % r->capacity]; }
static void ring_pop(ReRecorder *r) {
  ReFrame *f = r->ring[r->first];
  r->bytes -= f->size; r->ring[r->first] = NULL;
  r->first = (r->first + 1) % r->capacity; r->count--; r->dropped++;
  frame_unref(f);
}
static void line_pop(ReRecorder *r) {
  ReLine *line = &r->lines[r->line_first];
  r->line_bytes -= strlen(line->text) + 1; free(line->text); line->text = NULL;
  r->line_first = (r->line_first + 1) % r->line_capacity; r->line_count--;
}
static ReLine *line_at(const ReRecorder *r, int index) { return &r->lines[(r->line_first + index) % r->line_capacity]; }

ReRecorder *re_recording_open(const ReRecordOpen *options) {
  if (!options || !options->root_path || !*options->root_path) return NULL;
  ReRecorder *r = calloc(1, sizeof(*r));
  if (!r) return NULL;
  re_copy(r->root, sizeof(r->root), options->root_path);
  re_copy(r->root_id, sizeof(r->root_id), options->root_id);
  re_copy(r->session, sizeof(r->session), options->session_id);
  re_copy(r->game, sizeof(r->game), options->game_id);
  re_copy(r->title, sizeof(r->title), options->title);
  r->bounds = options->bounds; r->base_ms = options->now_ms; r->wall_base = options->wall_ms;
  r->announce = options->announce; r->announce_user = options->announce_user;
  r->capacity = clamp(r->bounds.seconds * r->bounds.fps + 4, 8, FRAME_SLOTS);
  r->line_capacity = LINE_SLOTS;
  r->ring = calloc((size_t)r->capacity, sizeof(*r->ring));
  r->lines = calloc((size_t)r->line_capacity, sizeof(*r->lines));
  if (!r->ring || !r->lines) { free(r->ring); free(r->lines); free(r); return NULL; }
  re_copy(r->message, sizeof(r->message), "ready");
  return r;
}

static long long wall_of(const ReRecorder *r, Uint64 at) { return r->wall_base + (long long)(at - r->base_ms); }
void re_recording_wall_iso(long long ms, char *out, size_t size) {
  time_t seconds = (time_t)(ms / 1000);
  int millis = (int)(ms % 1000);
  struct tm parts;
#ifdef _WIN32
  gmtime_s(&parts, &seconds);
#else
  gmtime_r(&seconds, &parts);
#endif
  snprintf(out, size, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", parts.tm_year + 1900, parts.tm_mon + 1, parts.tm_mday,
           parts.tm_hour, parts.tm_min, parts.tm_sec, millis);
}

static void evict(ReRecorder *r) {
  while (r->count > 1) {
    Uint64 newest = ring_at(r, r->count - 1)->at, oldest = ring_at(r, 0)->at;
    if (r->bytes <= (size_t)r->bounds.bytes && newest - oldest <= (Uint64)r->bounds.seconds * 1000) break;
    ring_pop(r);
  }
  while (r->line_count > 1) {
    Uint64 newest = line_at(r, r->line_count - 1)->at, oldest = line_at(r, 0)->at;
    if (r->line_bytes <= LINE_BYTES && newest - oldest <= (Uint64)r->bounds.seconds * 1000) break;
    line_pop(r);
  }
}

void re_recording_frame(ReRecorder *r, const unsigned char *rgba, int width, int height, int sequence, Uint64 now_ms) {
  if (!r || r->state == RE_RECORDING_STOPPED || !rgba || width < 1 || height < 1) return;
  if (r->sampled && now_ms - r->last_sample < (Uint64)(1000 / r->bounds.fps)) return;
  int dw = width < r->bounds.width ? width : r->bounds.width;
  int dh = height * dw / width;
  if (dh < 1) dh = 1;
  size_t needed = (size_t)dw * dh * 3;
  if (needed > r->scratch_size) {
    unsigned char *grown = realloc(r->scratch, needed);
    if (!grown) return;
    r->scratch = grown; r->scratch_size = needed;
  }
  re_recording_downscale(rgba, width, height, r->scratch, dw, dh);
  unsigned char *bytes = NULL; size_t size = 0;
  if (!re_jpeg_encode(r->scratch, dw, dh, r->bounds.quality, &bytes, &size)) return;
  ReFrame *frame = calloc(1, sizeof(*frame));
  if (!frame) { free(bytes); return; }
  frame->bytes = bytes; frame->size = size; frame->sequence = sequence; frame->at = now_ms; frame->refs = 1;
  if (r->count == r->capacity) ring_pop(r);
  r->ring[(r->first + r->count) % r->capacity] = frame;
  r->count++; r->bytes += size;
  r->last_sample = now_ms; r->sampled = true; r->encoded_width = dw; r->encoded_height = dh;
  evict(r);
}

static void line_push(ReRecorder *r, Uint64 now_ms) {
  r->partial[r->partial_size] = 0;
  char *text = strdup(r->partial);
  r->partial_size = 0;
  if (!text) return;
  if (r->line_count == r->line_capacity) line_pop(r);
  ReLine *line = &r->lines[(r->line_first + r->line_count) % r->line_capacity];
  line->at = now_ms; line->text = text;
  r->line_count++; r->line_bytes += strlen(text) + 1;
  evict(r);
}

void re_recording_output(ReRecorder *r, const char *bytes, size_t size, Uint64 now_ms) {
  if (!r || r->state == RE_RECORDING_STOPPED || !bytes) return;
  for (size_t i = 0; i < size; i++) {
    unsigned char c = (unsigned char)bytes[i];
    switch (r->sane) {
      case SANE_ESC: r->sane = c == '[' ? SANE_CSI : c == ']' ? SANE_OSC : SANE_TEXT; break;
      case SANE_CSI: if (c >= 0x40 && c <= 0x7e) r->sane = SANE_TEXT; break;
      case SANE_OSC: r->sane = c == 0x07 ? SANE_TEXT : c == 0x1b ? SANE_OSC_ESC : SANE_OSC; break;
      case SANE_OSC_ESC: r->sane = SANE_TEXT; break;
      default:
        if (c == 0x1b) { r->sane = SANE_ESC; break; }
        if (c == '\n') { line_push(r, now_ms); break; }
        if (c < 0x20 && c != '\t') break;
        if (r->partial_size < LINE_LIMIT) r->partial[r->partial_size++] = (char)c;
        break;
    }
  }
}

/* ---- committing ------------------------------------------------------------------------------ */

static bool ensure_directory(const char *path) {
  struct stat info;
  re_make_dir(path);
  return stat(path, &info) == 0 && (info.st_mode & S_IFDIR) != 0;
}
static void write_text(const char *path, const char *text) {
  FILE *handle = fopen(path, "wb");
  if (!handle) return;
  fwrite(text, 1, strlen(text), handle);
  fclose(handle);
}
static bool prepare_store(ReRecorder *r, const char *id, char *directory, size_t size) {
  char path[2048];
  snprintf(path, sizeof(path), "%s/.cache", r->root); ensure_directory(path);
  snprintf(path, sizeof(path), "%s/.cache/recordings", r->root);
  if (!ensure_directory(path)) return false;
  char ignore[2100];
  snprintf(ignore, sizeof(ignore), "%s/.gitignore", path);
  FILE *existing = fopen(ignore, "rb");
  if (existing) fclose(existing); else write_text(ignore, "*\n");   /* captures never offer themselves for commit */
  snprintf(directory, size, "%s/.cache/recordings/%s", r->root, id);
  if (!ensure_directory(directory)) return false;
  snprintf(path, sizeof(path), "%s/keyframes", directory);
  return ensure_directory(path);
}
static void mint_id(ReRecorder *r, Uint64 now_ms, char *out, size_t size) {
  long long wall = wall_of(r, now_ms);
  time_t seconds = (time_t)(wall / 1000);
  struct tm parts;
#ifdef _WIN32
  gmtime_s(&parts, &seconds);
#else
  gmtime_r(&seconds, &parts);
#endif
  unsigned suffix = (unsigned)(r->segments * 2654435761u);
  for (const char *s = r->session; *s; s++) suffix = suffix * 31u + (unsigned char)*s;
  suffix ^= (unsigned)(wall & 0xffffff);
  snprintf(out, size, "%04d%02d%02dT%02d%02d%02dZ-%06x", parts.tm_year + 1900, parts.tm_mon + 1, parts.tm_mday,
           parts.tm_hour, parts.tm_min, parts.tm_sec, suffix & 0xffffff);
}
/* Every line the ring still holds, stamped from the segment's first keyframe: a line printed before
 * the mark carries a negative atMs rather than being dropped, because the moment a recording is
 * started for is always just past and its explanation is in the lines already in. */
static void write_log(ReRecorder *r) {
  char path[2100];
  snprintf(path, sizeof(path), "%s/log.jsonl", r->commit.directory);
  FILE *handle = fopen(path, "wb");
  if (!handle) return;
  Uint64 origin = r->commit.frames[0]->at;
  char wall[40];
  for (int i = 0; i < r->line_count; i++) {
    ReLine *line = line_at(r, i);
    re_recording_wall_iso(wall_of(r, line->at), wall, sizeof(wall));
    cJSON *j = cJSON_CreateObject();
    cJSON_AddNumberToObject(j, "atMs", (double)((long long)line->at - (long long)origin));
    cJSON_AddStringToObject(j, "wall", wall);
    cJSON_AddStringToObject(j, "text", line->text);
    char *text = cJSON_PrintUnformatted(j);
    if (text) { fprintf(handle, "%s\n", text); r->commit.log_lines++; r->commit.log_bytes += strlen(text) + 1; free(text); }
    cJSON_Delete(j);
  }
  fclose(handle);
}
/* The live channel's vocabulary, which is not the manifest's: an explicit segment is "explicit" on
   the feed and "segment" in the artifact, because the feed names the gesture and the manifest names
   the shape (spec 095, "The feed"). */
static void announce(ReRecorder *r, const char *event, const char *id, int kind) {
  if (!r->announce || !id || !*id) return;
  ReRecordEvent frame = {r->root_id, r->session, r->game, event, id, kind == RE_KIND_RING ? "ring" : "explicit"};
  r->announce(r->announce_user, &frame);
}
static void begin_commit(ReRecorder *r, int kind, Uint64 from, int requested_seconds, Uint64 now_ms, int after) {
  int count = 0;
  for (int i = 0; i < r->count; i++) if (ring_at(r, i)->at >= from) count++;
  if (!count) {
    re_copy(r->message, sizeof(r->message), "nothing to commit yet");
    if (kind == RE_KIND_SEGMENT) r->explicit_id[0] = 0;
    r->state = after;
    return;
  }
  ReCommit *c = &r->commit;
  memset(c, 0, sizeof(*c));
  c->frames = calloc((size_t)count, sizeof(*c->frames));
  if (!c->frames) { if (kind == RE_KIND_SEGMENT) r->explicit_id[0] = 0; r->state = after; return; }
  for (int i = 0; i < r->count; i++) {
    ReFrame *frame = ring_at(r, i);
    if (frame->at < from) continue;
    frame->refs++; c->frames[c->count++] = frame;
  }
  c->kind = kind; c->from = from; c->requested_seconds = requested_seconds; c->after = after;
  c->dropped_lead = c->frames[0]->at > from ? c->frames[0]->at - from : 0;
  c->truncated = kind == RE_KIND_SEGMENT && c->dropped_lead > 0;
  /* An explicit segment already has its id: it was minted and announced when the toggle started it,
     and the pair on the feed has to name one directory. A ring commit mints its own here. */
  if (kind == RE_KIND_SEGMENT && *r->explicit_id) re_copy(c->id, sizeof(c->id), r->explicit_id);
  else mint_id(r, now_ms, c->id, sizeof(c->id));
  r->explicit_id[0] = 0;
  if (!prepare_store(r, c->id, c->directory, sizeof(c->directory))) {
    for (int i = 0; i < c->count; i++) frame_unref(c->frames[i]);
    free(c->frames); memset(c, 0, sizeof(*c));
    re_copy(r->message, sizeof(r->message), "cannot write into .cache/recordings");
    r->state = after;
    return;
  }
  re_copy(r->last_segment, sizeof(r->last_segment), c->id);
  snprintf(r->last_path, sizeof(r->last_path), ".cache/recordings/%s", c->id);
  write_log(r);
  char path[2100];
  snprintf(path, sizeof(path), "%s/keyframes.jsonl", c->directory);
  c->index = fopen(path, "wb");
  c->active = true;
  r->state = RE_RECORDING_COMMITTING;
  snprintf(r->message, sizeof(r->message), "committing 0/%d", c->count);
}
static void write_manifest(ReRecorder *r) {
  ReCommit *c = &r->commit;
  Uint64 origin = c->frames[0]->at, last = c->frames[c->count - 1]->at;
  char started[40], ended[40], created[40];
  re_recording_wall_iso(wall_of(r, origin), started, sizeof(started));
  re_recording_wall_iso(wall_of(r, last), ended, sizeof(ended));
  re_recording_wall_iso(wall_of(r, last), created, sizeof(created));
  cJSON *j = cJSON_CreateObject();
  cJSON_AddNumberToObject(j, "version", 1);
  cJSON_AddStringToObject(j, "id", c->id);
  cJSON_AddStringToObject(j, "kind", c->kind == RE_KIND_SEGMENT ? "segment" : "ring");
  cJSON_AddStringToObject(j, "rootId", r->root_id);
  cJSON_AddStringToObject(j, "sessionId", r->session);
  cJSON_AddStringToObject(j, "game", r->game);
  cJSON_AddStringToObject(j, "title", r->title);
  cJSON_AddStringToObject(j, "createdAt", created);
  cJSON_AddStringToObject(j, "startedAt", started);
  cJSON_AddStringToObject(j, "endedAt", ended);
  cJSON_AddNumberToObject(j, "durationMs", (double)(last - origin));
  cJSON *clock = cJSON_AddObjectToObject(j, "clock");
  cJSON_AddStringToObject(clock, "unit", "ms");
  cJSON_AddStringToObject(clock, "field", "atMs");
  cJSON_AddStringToObject(clock, "origin", "startedAt");
  cJSON_AddStringToObject(clock, "note", "atMs, sequence and wall are one clock across keyframes, log lines and any audio chunk.");
  cJSON *video = cJSON_AddObjectToObject(j, "video");
  cJSON_AddStringToObject(video, "codec", "jpeg");
  cJSON_AddNumberToObject(video, "width", r->encoded_width);
  cJSON_AddNumberToObject(video, "height", r->encoded_height);
  cJSON_AddNumberToObject(video, "fps", r->bounds.fps);
  cJSON_AddNumberToObject(video, "quality", r->bounds.quality);
  cJSON_AddNumberToObject(video, "frames", c->count);
  cJSON_AddNumberToObject(video, "bytes", (double)c->video_bytes);
  cJSON_AddStringToObject(video, "directory", "keyframes");
  cJSON_AddStringToObject(video, "index", "keyframes.jsonl");
  cJSON *log = cJSON_AddObjectToObject(j, "log");
  cJSON_AddStringToObject(log, "file", "log.jsonl");
  cJSON_AddNumberToObject(log, "lines", c->log_lines);
  cJSON_AddNumberToObject(log, "bytes", (double)c->log_bytes);
  cJSON *audio = cJSON_AddObjectToObject(j, "audio");
  cJSON_AddBoolToObject(audio, "present", false);
  cJSON_AddStringToObject(audio, "provider", "capture-mcp");
  cJSON_AddStringToObject(audio, "reason", "The game's audio goes to the system output device and never passes through the workspace; per-app capture and transcription belong to capture-mcp.");
  cJSON_AddStringToObject(audio, "issue", "KI-044");
  cJSON *ring = cJSON_AddObjectToObject(j, "ring");
  cJSON_AddNumberToObject(ring, "seconds", r->bounds.seconds);
  cJSON_AddNumberToObject(ring, "bytes", r->bounds.bytes);
  cJSON_AddNumberToObject(ring, "fps", r->bounds.fps);
  cJSON_AddNumberToObject(ring, "width", r->bounds.width);
  cJSON_AddNumberToObject(ring, "quality", r->bounds.quality);
  cJSON_AddNumberToObject(ring, "requestedSeconds", c->requested_seconds);
  cJSON_AddBoolToObject(ring, "truncated", c->truncated);
  cJSON_AddNumberToObject(ring, "droppedLeadMs", (double)c->dropped_lead);
  cJSON_AddNumberToObject(ring, "droppedFrames", r->dropped);
  cJSON_AddNumberToObject(j, "bytes", (double)(c->video_bytes + c->log_bytes));
  char *text = cJSON_Print(j);
  if (text) {
    char path[2100];
    snprintf(path, sizeof(path), "%s/manifest.json", c->directory);
    write_text(path, text);   /* last, so a directory without it is an unfinished commit */
    free(text);
  }
  cJSON_Delete(j);
}
static void finish_commit(ReRecorder *r) {
  ReCommit *c = &r->commit;
  if (c->index) { fclose(c->index); c->index = NULL; }
  write_manifest(r);
  r->segments++;
  announce(r, "committed", c->id, c->kind);
  snprintf(r->message, sizeof(r->message), "saved %s · %d frames · %d log lines", c->id, c->count, c->log_lines);
  for (int i = 0; i < c->count; i++) frame_unref(c->frames[i]);
  free(c->frames);
  int after = c->after;
  memset(c, 0, sizeof(*c));
  r->state = after;
  if (after == RE_RECORDING_STOPPED) {
    while (r->count) ring_pop(r);
    while (r->line_count) line_pop(r);
  }
}
void re_recording_tick(ReRecorder *r, Uint64 now_ms) {
  (void)now_ms;
  if (!r || r->state != RE_RECORDING_COMMITTING || !r->commit.active) return;
  ReCommit *c = &r->commit;
  Uint64 origin = c->frames[0]->at;
  char wall[40], path[2200], name[64];
  for (int step = 0; step < RE_RECORDING_DRAIN && c->written < c->count; step++, c->written++) {
    ReFrame *frame = c->frames[c->written];
    snprintf(name, sizeof(name), "keyframes/%06d.jpg", c->written + 1);
    snprintf(path, sizeof(path), "%s/%s", c->directory, name);
    FILE *handle = fopen(path, "wb");
    if (handle) { fwrite(frame->bytes, 1, frame->size, handle); fclose(handle); c->video_bytes += frame->size; }
    if (!c->index) continue;
    re_recording_wall_iso(wall_of(r, frame->at), wall, sizeof(wall));
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "file", name);
    cJSON_AddNumberToObject(j, "atMs", (double)(frame->at - origin));
    cJSON_AddStringToObject(j, "wall", wall);
    cJSON_AddNumberToObject(j, "sequence", frame->sequence);
    cJSON_AddNumberToObject(j, "bytes", (double)frame->size);
    char *text = cJSON_PrintUnformatted(j);
    if (text) { fprintf(c->index, "%s\n", text); free(text); }
    cJSON_Delete(j);
  }
  if (c->written < c->count) snprintf(r->message, sizeof(r->message), "committing %d/%d", c->written, c->count);
  else finish_commit(r);
}

void re_recording_commit_ring(ReRecorder *r, Uint64 now_ms) {
  if (!r || r->state == RE_RECORDING_COMMITTING || r->state == RE_RECORDING_STOPPED) return;
  begin_commit(r, RE_KIND_RING, 0, r->bounds.seconds, now_ms, RE_RECORDING_RING);
}
void re_recording_toggle(ReRecorder *r, Uint64 now_ms) {
  if (!r || r->state == RE_RECORDING_COMMITTING || r->state == RE_RECORDING_STOPPED) return;
  if (r->state == RE_RECORDING_ACTIVE) { begin_commit(r, RE_KIND_SEGMENT, r->explicit_from, 0, now_ms, RE_RECORDING_RING); return; }
  r->explicit_from = now_ms; r->state = RE_RECORDING_ACTIVE;
  mint_id(r, now_ms, r->explicit_id, sizeof(r->explicit_id));
  re_copy(r->message, sizeof(r->message), "recording");
  announce(r, "started", r->explicit_id, RE_KIND_SEGMENT);
}
void re_recording_exited(ReRecorder *r, Uint64 now_ms) {
  if (!r || r->state == RE_RECORDING_STOPPED || r->state == RE_RECORDING_COMMITTING) return;
  if (r->state == RE_RECORDING_ACTIVE) { begin_commit(r, RE_KIND_SEGMENT, r->explicit_from, 0, now_ms, RE_RECORDING_STOPPED); return; }
  r->state = RE_RECORDING_STOPPED;
  while (r->count) ring_pop(r);
  while (r->line_count) line_pop(r);
  re_copy(r->message, sizeof(r->message), "game exited");
}
int re_recording_state(const ReRecorder *r) { return r ? r->state : RE_RECORDING_STOPPED; }

void re_recording_close(ReRecorder *r) {
  if (!r) return;
  while (r->state == RE_RECORDING_COMMITTING) re_recording_tick(r, 0);   /* a commit in flight is bounded, so it ends */
  while (r->count) ring_pop(r);
  while (r->line_count) line_pop(r);
  free(r->ring); free(r->lines); free(r->scratch); free(r);
}

void re_recording_inspect(const ReRecorder *r, cJSON *out) {
  if (!r || !out) return;
  cJSON *j = cJSON_AddObjectToObject(out, "recording");
  static const char *names[] = {"ring", "recording", "committing", "stopped"};
  cJSON_AddStringToObject(j, "state", names[r->state]);
  cJSON_AddNumberToObject(j, "frames", r->count);
  cJSON_AddNumberToObject(j, "bytes", (double)r->bytes);
  cJSON_AddNumberToObject(j, "spanMs", (double)(r->count ? ring_at(r, r->count - 1)->at - ring_at(r, 0)->at : 0));
  cJSON_AddNumberToObject(j, "logLines", r->line_count);
  cJSON_AddNumberToObject(j, "segments", r->segments);
  cJSON_AddStringToObject(j, "lastSegment", r->last_segment);
  cJSON_AddStringToObject(j, "lastPath", r->last_path);
  cJSON_AddNumberToObject(j, "ringSeconds", r->bounds.seconds);
  cJSON_AddNumberToObject(j, "ringBytes", r->bounds.bytes);
  cJSON_AddNumberToObject(j, "fps", r->bounds.fps);
  cJSON_AddNumberToObject(j, "width", r->bounds.width);
  cJSON_AddNumberToObject(j, "pending", r->commit.active ? r->commit.count - r->commit.written : 0);
  cJSON_AddStringToObject(j, "message", r->message);
}

/* ---- the workspace side ----------------------------------------------------------------------- */

static const char *root_directory(struct ReApp *a, const char *id) {
  const cJSON *root = NULL;
  cJSON_ArrayForEach(root, cJSON_GetObjectItemCaseSensitive(a->state, "roots"))
    if (!strcmp(re_string(root, "id"), id)) return re_string(root, "path");
  return "";
}
static const cJSON *session_record(struct ReApp *a, const char *id) {
  const cJSON *session = NULL;
  cJSON_ArrayForEach(session, cJSON_GetObjectItemCaseSensitive(a->state, "sessions"))
    if (!strcmp(re_string(session, "id"), id)) return session;
  return NULL;
}
static void take_frame(void *user, const unsigned char *rgba, int width, int height, int sequence) {
  re_recording_frame(user, rgba, width, height, sequence, SDL_GetTicks64());
}

void re_recording_sync(struct ReApp *a) {
  Uint64 now = SDL_GetTicks64();
  long long wall = (long long)time(NULL) * 1000;
  for (int i = 0; i < RE_TABS; i++) {
    ReTab *t = &a->tabs[i];
    if (t->recorder && !t->game) { re_recording_close(t->recorder); t->recorder = NULL; }
    if (!t->game) continue;
    if (!t->recorder) {
      const char *directory = root_directory(a, t->root);
      if (!*directory || !*t->session) continue;
      const cJSON *session = session_record(a, t->session);
      ReRecordOpen options = {directory, t->root, t->session, re_string(session, "game"), t->title,
                              re_recording_bounds(cJSON_GetObjectItemCaseSensitive(a->state, "preferences")), now, wall,
                              re_token_recording, a};   /* every commit reaches the live channel (spec 095) */
      t->recorder = re_recording_open(&options);
      if (t->recorder) re_game_sink(t->game, take_frame, t->recorder);
      continue;
    }
    const cJSON *session = session_record(a, t->session);
    if (session && strcmp(re_string(session, "state"), "running")) re_recording_exited(t->recorder, now);
    re_recording_tick(t->recorder, now);
  }
}
void re_recording_output_event(struct ReApp *a, const cJSON *event) {
  const char *id = re_string(event, "id"), *data = re_string(event, "data");
  if (!*id || !*data) return;
  for (int i = 0; i < RE_TABS; i++)
    if (a->tabs[i].recorder && !strcmp(a->tabs[i].session, id)) re_recording_output(a->tabs[i].recorder, data, strlen(data), SDL_GetTicks64());
}

void re_recording_ui(struct ReApp *a, mu_Context *ui, int tab) {
  ReTab *t = &a->tabs[tab];
  ReRecorder *r = t->recorder;
  int state = re_recording_state(r);
  bool busy = !r || state == RE_RECORDING_COMMITTING || state == RE_RECORDING_STOPPED;
  char commit[64];
  snprintf(commit, sizeof(commit), "Commit last %d s", r ? r->bounds.seconds : 0);
  if (re_ui_button_ex(ui, state == RE_RECORDING_ACTIVE ? "Stop" : "Record",
                      RE_ICON_RUN, (state == RE_RECORDING_ACTIVE ? RE_UI_ON : 0) | (busy ? RE_UI_DISABLED : 0)) && !busy) {
    re_recording_toggle(r, SDL_GetTicks64());
  }
  re_app_control(a, ui, "recording", "toggle", tab);
  if (re_ui_button_ex(ui, commit, RE_ICON_UNKNOWN, RE_UI_GHOST | (busy ? RE_UI_DISABLED : 0)) && !busy) {
    re_recording_commit_ring(r, SDL_GetTicks64());
  }
  re_app_control(a, ui, "recording", "commit", tab);
  char label[512];
  if (!r) snprintf(label, sizeof(label), "%s · recording unavailable for this view", t->game->status);
  else if (state == RE_RECORDING_ACTIVE) {
    snprintf(label, sizeof(label), "%s · recording %d frames · ring %d s / %d MiB", t->game->status,
             r->count, r->bounds.seconds, r->bounds.bytes / (1024 * 1024));
  } else {
    snprintf(label, sizeof(label), "%s · %s · ring %d s / %d MiB holding %d frames", t->game->status, r->message,
             r->bounds.seconds, r->bounds.bytes / (1024 * 1024), r->count);
  }
  re_ui_label_ex(ui, label, RE_UI_MUTED | RE_UI_SMALL);
  re_app_control(a, ui, "recording", "status", tab);
}

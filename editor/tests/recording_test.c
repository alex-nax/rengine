#include "recording.h"
#include <assert.h>

#ifdef _WIN32
#include <direct.h>
#define make_dir(p) _mkdir(p)
#define drop_dir(p) _rmdir(p)
#else
#include <sys/stat.h>
#include <unistd.h>
#define make_dir(p) mkdir((p), 0755)
#define drop_dir(p) rmdir(p)
#endif

static const long long WALL = 1788727512340LL;   /* fixed, so every id and wall clock is reproducible */
static unsigned char pixels[64 * 36 * 4];

static void paint(int seed) {
  for (int y = 0; y < 36; y++) for (int x = 0; x < 64; x++) {
    unsigned char *p = pixels + ((size_t)y * 64 + x) * 4;
    p[0] = (unsigned char)(x * 4 + seed); p[1] = (unsigned char)(y * 7); p[2] = (unsigned char)(seed * 3); p[3] = 255;
  }
}
static char *read_file(const char *path, size_t *size) {
  FILE *handle = fopen(path, "rb");
  if (!handle) return NULL;
  fseek(handle, 0, SEEK_END); long length = ftell(handle); fseek(handle, 0, SEEK_SET);
  char *bytes = malloc((size_t)length + 1);
  if (bytes && fread(bytes, 1, (size_t)length, handle) != (size_t)length) { free(bytes); bytes = NULL; }
  if (bytes) bytes[length] = 0;
  if (size) *size = (size_t)length;
  fclose(handle); return bytes;
}
static void say(ReRecorder *r, const char *text, Uint64 now) { re_recording_output(r, text, strlen(text), now); }
static bool exists(const char *path) { FILE *h = fopen(path, "rb"); if (h) fclose(h); return h != NULL; }
static int lines_in(const char *path) {
  size_t size = 0; char *text = read_file(path, &size);
  assert(text); int count = 0;
  for (size_t i = 0; i < size; i++) if (text[i] == '\n') count++;
  free(text); return count;
}
static cJSON *read_json(const char *path) {
  char *text = read_file(path, NULL); assert(text);
  cJSON *j = cJSON_Parse(text); free(text); assert(j); return j;
}
/* The inspected state is what the native fixture asserts on, so the unit test reads the same view. */
static cJSON *inspect(ReRecorder *r) {
  cJSON *out = cJSON_CreateObject(); re_recording_inspect(r, out);
  cJSON *value = cJSON_DetachItemFromObjectCaseSensitive(out, "recording");
  cJSON_Delete(out); assert(value); return value;
}
static int inspected(ReRecorder *r, const char *key) {
  cJSON *j = inspect(r); int value = re_number(j, key); cJSON_Delete(j); return value;
}
static char *inspected_text(ReRecorder *r, const char *key) {
  cJSON *j = inspect(r); char *value = strdup(re_string(j, key)); cJSON_Delete(j); return value;
}
static ReRecorder *open_at(const char *root, ReRecordBounds bounds, const char *session) {
  ReRecordOpen options = {root, "root-1", session, "fixture-game", "Fixture game", bounds, 0, WALL};
  ReRecorder *r = re_recording_open(&options); assert(r); return r;
}
static void drain(ReRecorder *r, Uint64 *now) {
  for (int i = 0; i < 4000 && re_recording_state(r) == RE_RECORDING_COMMITTING; i++) re_recording_tick(r, *now += 16);
  assert(re_recording_state(r) != RE_RECORDING_COMMITTING);
}
/* Every run gets its own tree and removes it again: the ids are deterministic on purpose, so a
   leftover segment from an aborted run would answer an assertion about what this run wrote. */
static char kept[16][2048]; static int kept_count;
static void keep(const char *directory) { if (kept_count < 16) snprintf(kept[kept_count++], sizeof(kept[0]), "%s", directory); }
static void purge(const char *root) {
  char path[2300];
  for (int i = 0; i < kept_count; i++) {
    for (int n = 1; n < 100000; n++) {
      snprintf(path, sizeof(path), "%s/keyframes/%06d.jpg", kept[i], n);
      if (remove(path) != 0) break;
    }
    snprintf(path, sizeof(path), "%s/keyframes", kept[i]); drop_dir(path);
    for (int f = 0; f < 3; f++) {
      const char *names[] = {"keyframes.jsonl", "log.jsonl", "manifest.json"};
      snprintf(path, sizeof(path), "%s/%s", kept[i], names[f]); remove(path);
    }
    drop_dir(kept[i]);
  }
  snprintf(path, sizeof(path), "%s/.cache/recordings/.gitignore", root); remove(path);
  snprintf(path, sizeof(path), "%s/.cache/recordings", root); drop_dir(path);
  snprintf(path, sizeof(path), "%s/.cache", root); drop_dir(path);
  drop_dir(root);
}
static char *segment_path(ReRecorder *r, const char *root, const char *file) {
  char *id = inspected_text(r, "lastSegment"); assert(*id);
  char *path = malloc(2048); assert(path);
  snprintf(path, 2048, "%s/.cache/recordings/%s%s%s", root, id, *file ? "/" : "", file);
  free(id); return path;
}

int main(void) {
  char run[1024];
  make_dir(RENGINE_TEST_TMP);
  snprintf(run, sizeof(run), "%s/run-%08x", RENGINE_TEST_TMP, (unsigned)(SDL_GetPerformanceCounter() & 0xffffffffu));
  make_dir(run);
  const char *root = run;

  /* ---- bounds: defaults, then the preference, clamped ---------------------------------------- */
  ReRecordBounds fallback = re_recording_bounds(NULL);
  assert(fallback.seconds == 120 && fallback.bytes == 64 * 1024 * 1024 && fallback.fps == 10);
  assert(fallback.width == 640 && fallback.quality == 70);
  cJSON *preferences = cJSON_CreateObject(), *declared = cJSON_AddObjectToObject(preferences, "recording");
  cJSON_AddNumberToObject(declared, "seconds", 9000);   /* above the range */
  cJSON_AddNumberToObject(declared, "fps", 0);          /* below the range */
  cJSON_AddNumberToObject(declared, "width", 480);
  ReRecordBounds clamped = re_recording_bounds(preferences);
  assert(clamped.seconds == 900 && clamped.fps == 1 && clamped.width == 480 && clamped.quality == 70);
  cJSON_Delete(preferences);

  /* ---- the surface protocol's rows are bottom-up; the image is not ---------------------------- */
  unsigned char source[2 * 2 * 4] = {
    9, 9, 9, 255,  9, 9, 9, 255,        /* row 0 is the screen's BOTTOM */
    200, 100, 50, 255,  200, 100, 50, 255,
  };
  unsigned char scaled[2 * 2 * 3] = {0};
  re_recording_downscale(source, 2, 2, scaled, 2, 2);
  assert(scaled[0] == 200 && scaled[1] == 100 && scaled[2] == 50);   /* the image's top row */
  assert(scaled[6] == 9 && scaled[7] == 9 && scaled[8] == 9);
  unsigned char single[1 * 1 * 3] = {0};
  re_recording_downscale(source, 2, 2, single, 1, 1);
  assert(single[0] == 104 && single[1] == 54 && single[2] == 29);    /* box average of both rows */

  /* ---- the ring holds a window in seconds ----------------------------------------------------- */
  {
    ReRecordBounds bounds = {1, 64 * 1024 * 1024, 10, 64, 70};
    ReRecorder *r = open_at(root, bounds, "seconds");
    Uint64 now = 0;
    for (int i = 0; i <= 20; i++) { paint(i); re_recording_frame(r, pixels, 64, 36, 1000 + i, now); now += 100; }
    assert(inspected(r, "frames") == 11);        /* 1,000 ms of a 10 fps ring, endpoints included */
    assert(inspected(r, "ringSeconds") == 1);
    re_recording_close(r);
  }
  /* ---- and a window in bytes, whichever binds first ------------------------------------------- */
  {
    ReRecordBounds bounds = {600, 4096, 10, 64, 70};
    ReRecorder *r = open_at(root, bounds, "bytes");
    Uint64 now = 0;
    for (int i = 0; i < 40; i++) {
      paint(i); re_recording_frame(r, pixels, 64, 36, 2000 + i, now); now += 100;
      int held = inspected(r, "bytes");
      assert(held <= 4096 || inspected(r, "frames") == 1);
    }
    assert(inspected(r, "frames") < 40 && inspected(r, "frames") > 0);
    re_recording_close(r);
  }
  /* ---- frames are sampled at the declared rate, not at the pane's ----------------------------- */
  {
    ReRecordBounds bounds = {120, 64 * 1024 * 1024, 5, 64, 70};
    ReRecorder *r = open_at(root, bounds, "rate");
    Uint64 now = 0;
    for (int i = 0; i < 60; i++) { paint(i); re_recording_frame(r, pixels, 64, 36, 3000 + i, now); now += 16; }
    assert(inspected(r, "frames") == 5);   /* 960 ms at 5 fps: t=0, 200, 400, 600, 800 */
    re_recording_close(r);
  }

  /* ---- commit the ring: a drain that writes its manifest last --------------------------------- */
  {
    ReRecordBounds bounds = {120, 64 * 1024 * 1024, 10, 64, 70};
    ReRecorder *r = open_at(root, bounds, "ring-commit");
    Uint64 now = 0;
    for (int i = 0; i < 40; i++) {
      paint(i); re_recording_frame(r, pixels, 64, 36, 4000 + i, now);
      say(r, "\x1b[32mLoadWorld\x1b[0m Worlds\r\n", now);
      now += 100;
    }
    assert(inspected(r, "frames") == 40 && inspected(r, "logLines") == 40);
    re_recording_commit_ring(r, now);
    assert(re_recording_state(r) == RE_RECORDING_COMMITTING);
    re_recording_tick(r, now += 16);
    char *pending = segment_path(r, root, "manifest.json");
    assert(!exists(pending));   /* 40 keyframes need two ticks; an unfinished commit has no manifest */
    free(pending);
    drain(r, &now);
    assert(inspected(r, "segments") == 1);
    { char *made = segment_path(r, root, ""); keep(made); free(made); }

    char *manifest_path = segment_path(r, root, "manifest.json"), *index_path = segment_path(r, root, "keyframes.jsonl");
    char *log_path = segment_path(r, root, "log.jsonl"), *first = segment_path(r, root, "keyframes/000001.jpg");
    assert(exists(manifest_path) && exists(index_path) && exists(log_path) && exists(first));
    cJSON *manifest = read_json(manifest_path);
    assert(re_number(manifest, "version") == 1);
    assert(!strcmp(re_string(manifest, "kind"), "ring"));
    assert(!strcmp(re_string(manifest, "game"), "fixture-game"));
    assert(!strcmp(re_string(manifest, "rootId"), "root-1"));
    cJSON *video = cJSON_GetObjectItemCaseSensitive(manifest, "video");
    assert(re_number(video, "frames") == 40 && re_number(video, "width") == 64 && re_number(video, "fps") == 10);
    assert(!strcmp(re_string(video, "codec"), "jpeg"));
    assert(re_number(manifest, "durationMs") == 3900);
    cJSON *audio = cJSON_GetObjectItemCaseSensitive(manifest, "audio");
    assert(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(audio, "present")));
    assert(!strcmp(re_string(audio, "issue"), "KI-044"));   /* declared, never silently dropped */
    assert(!strcmp(re_string(manifest, "startedAt"), "2026-09-06T20:45:12.340Z"));
    cJSON_Delete(manifest);

    assert(lines_in(index_path) == 40 && lines_in(log_path) == 40);
    size_t size = 0; char *index = read_file(index_path, &size);
    assert(strstr(index, "\"file\":\"keyframes/000001.jpg\""));
    assert(strstr(index, "\"atMs\":0,"));
    assert(strstr(index, "\"sequence\":4039"));
    assert(strstr(index, "\"wall\":\"2026-09-06T20:45:12.340Z\""));
    free(index);
    char *log = read_file(log_path, NULL);
    assert(strstr(log, "\"text\":\"LoadWorld Worlds\""));   /* ANSI and CR are stripped from the slice */
    assert(!strchr(log, 0x1b) && !strchr(log, '\r'));
    assert(strstr(log, "\"atMs\":0,"));
    free(log);
    size_t jpeg_size = 0; char *jpeg = read_file(first, &jpeg_size);
    assert(jpeg_size > 3 && (unsigned char)jpeg[0] == 0xff && (unsigned char)jpeg[1] == 0xd8);
    free(jpeg);
    free(manifest_path); free(index_path); free(log_path); free(first);
    re_recording_close(r);
  }

  /* ---- a log line older than the first keyframe keeps a negative atMs -------------------------- */
  {
    ReRecordBounds bounds = {120, 64 * 1024 * 1024, 10, 64, 70};
    ReRecorder *r = open_at(root, bounds, "log-lead");
    Uint64 now = 0;
    say(r, "before any frame\n", now);
    now += 300;
    for (int i = 0; i < 3; i++) { paint(i); re_recording_frame(r, pixels, 64, 36, 9000 + i, now); now += 100; }
    re_recording_commit_ring(r, now);
    drain(r, &now);
    { char *made = segment_path(r, root, ""); keep(made); free(made); }
    char *log_path = segment_path(r, root, "log.jsonl");
    char *log = read_file(log_path, NULL);
    assert(strstr(log, "\"atMs\":-300,"));   /* atMs is measured from the first keyframe, and says so */
    free(log); free(log_path);
    re_recording_close(r);
  }

  /* ---- explicit start and stop: the same artifact, and an honest truncation -------------------- */
  {
    ReRecordBounds bounds = {120, 64 * 1024 * 1024, 10, 64, 70};
    ReRecorder *r = open_at(root, bounds, "explicit");
    Uint64 now = 0;
    for (int i = 0; i < 5; i++) { paint(i); re_recording_frame(r, pixels, 64, 36, 5000 + i, now); now += 100; }
    say(r, "the moment just past\n", 250);
    re_recording_toggle(r, now);
    assert(re_recording_state(r) == RE_RECORDING_ACTIVE);
    for (int i = 0; i < 10; i++) { paint(i); re_recording_frame(r, pixels, 64, 36, 5100 + i, now); now += 100; }
    say(r, "and one inside the window\n", 900);
    re_recording_toggle(r, now);
    drain(r, &now);
    { char *made = segment_path(r, root, ""); keep(made); free(made); }
    char *manifest_path = segment_path(r, root, "manifest.json");
    cJSON *manifest = read_json(manifest_path);
    assert(!strcmp(re_string(manifest, "kind"), "segment"));
    assert(re_number(cJSON_GetObjectItemCaseSensitive(manifest, "video"), "frames") == 10);
    assert(cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(cJSON_GetObjectItemCaseSensitive(manifest, "ring"), "truncated")));
    /* The ring's lines are the segment's context, so the mark never discards them. */
    assert(re_number(cJSON_GetObjectItemCaseSensitive(manifest, "log"), "lines") == 2);
    char *log_path = segment_path(r, root, "log.jsonl"), *log = read_file(log_path, NULL);
    assert(log && lines_in(log_path) == 2);
    assert(strstr(log, "\"atMs\":-250,") && strstr(log, "\"text\":\"the moment just past\""));
    assert(strstr(log, "\"atMs\":400,") && strstr(log, "\"text\":\"and one inside the window\""));
    free(log); free(log_path);
    cJSON_Delete(manifest); free(manifest_path);
    re_recording_close(r);
  }
  {
    ReRecordBounds bounds = {1, 64 * 1024 * 1024, 10, 64, 70};
    ReRecorder *r = open_at(root, bounds, "outrun");
    Uint64 now = 0;
    re_recording_toggle(r, now);
    for (int i = 0; i < 30; i++) { paint(i); re_recording_frame(r, pixels, 64, 36, 6000 + i, now); now += 100; }
    re_recording_toggle(r, now);
    drain(r, &now);
    { char *made = segment_path(r, root, ""); keep(made); free(made); }
    char *manifest_path = segment_path(r, root, "manifest.json");
    cJSON *manifest = read_json(manifest_path), *ring = cJSON_GetObjectItemCaseSensitive(manifest, "ring");
    assert(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(ring, "truncated")));
    assert(re_number(ring, "droppedLeadMs") > 0);   /* it says where the segment really begins */
    cJSON_Delete(manifest); free(manifest_path);
    re_recording_close(r);
  }

  /* ---- the session exits: an open segment is committed, not lost ------------------------------- */
  {
    ReRecordBounds bounds = {120, 64 * 1024 * 1024, 10, 64, 70};
    ReRecorder *r = open_at(root, bounds, "exit");
    Uint64 now = 0;
    re_recording_toggle(r, now);
    for (int i = 0; i < 6; i++) { paint(i); re_recording_frame(r, pixels, 64, 36, 7000 + i, now); now += 100; }
    re_recording_exited(r, now);
    assert(re_recording_state(r) == RE_RECORDING_COMMITTING);
    drain(r, &now);
    assert(re_recording_state(r) == RE_RECORDING_STOPPED);
    { char *made = segment_path(r, root, ""); keep(made); free(made); }
    char *manifest_path = segment_path(r, root, "manifest.json");
    assert(exists(manifest_path)); free(manifest_path);
    paint(9); re_recording_frame(r, pixels, 64, 36, 7100, now += 100);
    assert(inspected(r, "frames") == 0);   /* a stopped ring keeps nothing further */
    re_recording_close(r);
  }
  /* ---- closing during a drain finishes the commit ---------------------------------------------- */
  {
    ReRecordBounds bounds = {120, 64 * 1024 * 1024, 10, 64, 70};
    ReRecorder *r = open_at(root, bounds, "close-drain");
    Uint64 now = 0;
    for (int i = 0; i < 60; i++) { paint(i); re_recording_frame(r, pixels, 64, 36, 8000 + i, now); now += 100; }
    re_recording_commit_ring(r, now);
    re_recording_tick(r, now += 16);
    assert(re_recording_state(r) == RE_RECORDING_COMMITTING);
    char *manifest_path = segment_path(r, root, "manifest.json");
    assert(!exists(manifest_path));
    { char *made = segment_path(r, root, ""); keep(made); free(made); }
    re_recording_close(r);
    assert(exists(manifest_path));
    cJSON *manifest = read_json(manifest_path);
    assert(re_number(cJSON_GetObjectItemCaseSensitive(manifest, "video"), "frames") == 60);
    cJSON_Delete(manifest); free(manifest_path);
  }

  purge(root);
  puts("recording ring, commit gestures, manifest and drain checks passed");
  return 0;
}

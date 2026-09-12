/* The companion's native entry (charter D57, spec 128 decisions 7, 8 and 10).
 *
 * Decision 7: the C layer drives and Rust serves. This is that C layer -- it owns the frame loop
 * exactly as the desktop's `main.c` does, and everything it draws with is the desktop's own: the
 * generated theme, `ReDraw`, and the owned control layer of charter D33. There is no phone
 * stylesheet and no second widget set; a button here is `re_ui_button_ex`, the same function the
 * IDE calls, so the two cannot drift apart by being written twice.
 */
#include <android/asset_manager.h>
#include <android/configuration.h>
#include <android/log.h>
#include <android/native_window.h>
#include <android/window.h>
#include <android_native_app_glue.h>
#include <sys/stat.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "draw.h"
#include "render/font.h"
#include "render/icons.h"
#include "render/seam_backends.h"
#include "theme.h"
#include "ui/ui.h"

#define TAG "rengine.companion"
#define SAY(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

/* This binary carries ONE backend, as a game does (D14b) -- the desktop is the only thing that links
   three prefixed copies. draw.c's dispatch still names all of them, so the one not compiled in
   answers here rather than failing to link. */
#if defined(RE_COMPANION_VULKAN)
#define COMPANION_BACKEND "vulkan"
ReBackend *re_opengl_backend_seam_open(void *w, ReFontSet *f);
uint32_t re_opengl_backend_seam_window_flags(void);
ReBackend *re_opengl_backend_seam_open(void *w, ReFontSet *f) { (void)w; (void)f; return NULL; }
uint32_t re_opengl_backend_seam_window_flags(void) { return 0; }
#else
#define COMPANION_BACKEND "opengl"
ReBackend *re_vulkan_backend_seam_open(void *w, ReFontSet *f);
uint32_t re_vulkan_backend_seam_window_flags(void);
ReBackend *re_vulkan_backend_seam_open(void *w, ReFontSet *f) { (void)w; (void)f; return NULL; }
uint32_t re_vulkan_backend_seam_window_flags(void) { return 0; }
#endif

static ReDraw *draw;
static mu_Context ui;
static int frames;
static double slowest_ms;
static float density = 1.0f;
static int taps;
/* A finger has no hover. The pointer is parked off-screen once a touch ends so nothing keeps the
   hovered look a mouse would have earned by staying there. */
static int released;

/* The mono face every Android build has; the UI and icon faces ride in the APK (see stage_fonts). */
static const char *MONO = "/system/fonts/DroidSansMono.ttf";

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec * 1000.0 + (double)t.tv_nsec / 1000000.0;
}

/* Inter and Phosphor are packaged rather than copied: Gradle stages the repository's vendored faces
   into the APK's assets, and this unpacks them where `fopen` can reach them. The desktop compiles
   the vendored path in; a packaged app only learns it at run time, which is what re_font_bundle_dir
   exists for. */
static void unpack(AAssetManager *assets, const char *dir, const char *base) {
  char made[512];
  snprintf(made, sizeof(made), "%s/%s", base, dir);
  mkdir(made, 0700);
  AAssetDir *listing = AAssetManager_openDir(assets, dir);
  if (!listing) return;
  const char *name;
  while ((name = AAssetDir_getNextFileName(listing)) != NULL) {
    char source[512], target[1024];
    snprintf(source, sizeof(source), "%s/%s", dir, name);
    snprintf(target, sizeof(target), "%s/%s/%s", base, dir, name);
    AAsset *asset = AAssetManager_open(assets, source, AASSET_MODE_BUFFER);
    if (!asset) continue;
    FILE *out = fopen(target, "wb");
    if (out) {
      fwrite(AAsset_getBuffer(asset), 1, (size_t)AAsset_getLength(asset), out);
      fclose(out);
    }
    AAsset_close(asset);
  }
  AAssetDir_close(listing);
}
static void stage_fonts(struct android_app *app, char *out, size_t size) {
  snprintf(out, size, "%s/fonts", app->activity->internalDataPath);
  mkdir(out, 0700);
  unpack(app->activity->assetManager, "inter", out);
  unpack(app->activity->assetManager, "phosphor", out);
}

/* One frame of the shared UI, built the way the desktop builds one: the frame opens, the owned
   controls draw into its list as they are built, and microui's replayed commands land above them. */
static void draw_frame(int width, int height) {
  double started = now_ms();
  /* Logical pixels, as the draw list's contract says. `re_draw_begin` asks the backend for the
     density by dividing the drawable it owns by the width passed here, so passing the physical size
     would report a density of 1 and draw the whole interface at a third of its size. */
  int logical_w = (int)((float)width / density), logical_h = (int)((float)height / density);
  re_draw_begin(draw, logical_w, logical_h);

  mu_begin(&ui);
  re_ui_begin(draw, started / 1000.0);
  if (mu_begin_window_ex(&ui, RE_PRODUCT_NAME " companion", mu_rect(0, 0, logical_w, logical_h),
                         MU_OPT_NOCLOSE | MU_OPT_NORESIZE | MU_OPT_NOTITLE | MU_OPT_NOFRAME)) {
    /* microui remembers a window's rect by name after the first frame, which is right for a desktop
       where a person moves it and wrong for a phone where the display decides. Rotating gave a new
       surface and the same remembered rect, so the layout kept its old shape. */
    mu_get_current_container(&ui)->rect = mu_rect(0, 0, logical_w, logical_h);

    mu_layout_row(&ui, 2, (int[]){-110, -1}, RE_METRIC_SESSIONS_ROW_HEIGHT);
    re_ui_label_ex(&ui, RE_PRODUCT_NAME " companion", RE_UI_LARGE | RE_UI_STRONG);
    re_ui_pill(&ui, "offline", RE_UI_PILL_WARN);

    mu_layout_row(&ui, 1, (int[]){-1}, RE_METRIC_SESSIONS_ROW_HEIGHT);
    re_ui_label_ex(&ui, "workspace", RE_UI_SMALL | RE_UI_MUTED);
    re_ui_row_ex(&ui, "contract", RE_ICON_PROJECT, "red.v1  /red/1", 0, 0);
    re_ui_row_ex(&ui, "renderer", RE_ICON_RUN, re_draw_backend(draw), 0, 0);
    char measured[64];
    snprintf(measured, sizeof(measured), "%dx%d  @%.2fx", logical_w, logical_h, (double)density);
    re_ui_row_ex(&ui, "surface", RE_ICON_TREE, measured, 0, 0);

    mu_layout_row(&ui, 1, (int[]){-1}, RE_METRIC_SESSIONS_ROW_HEIGHT);
    re_ui_label_ex(&ui, "actions", RE_UI_SMALL | RE_UI_MUTED);
    /* One segmented group, the shape the IDE's toolbars use: the ends round and the middle squares. */
    /* microui reads a negative width as "to this many pixels from the right edge", so an even
       split is arithmetic rather than three -1s, which would give the first column everything. */
    int third = (logical_w - 2 * RE_METRIC_MICROUI_PADDING - 2 * ui.style->spacing) / 3;
    mu_layout_row(&ui, 3, (int[]){third, third, -1}, RE_METRIC_TOOLBAR_ROW_HEIGHT);
    if (re_ui_button_ex(&ui, "Sessions", RE_ICON_SHELL, RE_UI_GROUP_FIRST)) { taps++; SAY("companion: Sessions pressed"); }
    if (re_ui_button_ex(&ui, "Tasks", RE_ICON_TREE, RE_UI_GROUP_MIDDLE)) { taps++; SAY("companion: Tasks pressed"); }
    if (re_ui_button_ex(&ui, "Approve", RE_ICON_CHECK, RE_UI_GROUP_LAST)) { taps++; SAY("companion: Approve pressed"); }

    mu_layout_row(&ui, 1, (int[]){-1}, RE_METRIC_TOOLBAR_ROW_HEIGHT);
    if (re_ui_button_ex(&ui, "Attach to a host", RE_ICON_AGENT, RE_UI_PRIMARY)) { taps++; SAY("companion: Attach pressed"); }

    char counted[64];
    snprintf(counted, sizeof(counted), "%d tap(s) so far", taps);
    mu_layout_row(&ui, 1, (int[]){-1}, RE_METRIC_SESSIONS_ROW_HEIGHT);
    re_ui_label_ex(&ui, counted, RE_UI_SMALL | RE_UI_MUTED);
    mu_end_window(&ui);
  }
  re_ui_end(draw);
  mu_end(&ui);
  if (released) { mu_input_mousemove(&ui, -1, -1); released = 0; }

  re_draw_commands(draw, &ui);
  re_ui_overlay_flush(draw);
  re_draw_end(draw);

  double took = now_ms() - started;
  if (took > slowest_ms) slowest_ms = took;
  if (++frames % 120 == 0) SAY("companion: %d frames, slowest %.2f ms", frames, slowest_ms);
}

static void on_command(struct android_app *app, int32_t command) {
  if (command == APP_CMD_INIT_WINDOW && app->window && !draw) {
    /* Android reports density in dpi buckets; 160 is the baseline a logical pixel is defined by. */
    density = (float)AConfiguration_getDensity(app->config) / 160.0f;
    if (density < 1.0f || density > 8.0f) density = 2.0f;
    char bundle[512];
    stage_fonts(app, bundle, sizeof(bundle));
    re_font_bundle_dir(bundle);
    draw = re_draw_open(app->window, MONO, COMPANION_BACKEND);
    if (!draw) { SAY("companion: no renderer: %s", re_font_error()); return; }
    re_draw_bind(draw, &ui);
    SAY("companion: renderer up on the %s backend at density %.2f, drawing the desktop's UI layer",
        re_draw_backend(draw), (double)density);
  } else if (command == APP_CMD_TERM_WINDOW && draw) {
    re_draw_close(draw);
    draw = NULL;
  }
}

/* Touch, as a mouse. microui only knows a pointer, and one finger is exactly that: the press sets
   focus and the release ends it. A tap whose down and up both land between two frames still submits
   -- `mouse_down` is already clear but `mouse_pressed` survives until `mu_end`, which is the frame
   that sees it. This runs on the loop's own thread (the glue calls it from `source->process`), so
   it shares `ui` with `draw_frame` without a queue. */
static int32_t on_input(struct android_app *app, AInputEvent *event) {
  (void)app;
  if (!draw || AInputEvent_getType(event) != AINPUT_EVENT_TYPE_MOTION) return 0;
  int x = (int)(AMotionEvent_getX(event, 0) / density);
  int y = (int)(AMotionEvent_getY(event, 0) / density);
  switch (AMotionEvent_getAction(event) & AMOTION_EVENT_ACTION_MASK) {
    case AMOTION_EVENT_ACTION_DOWN:
      SAY("companion: touch down at %d,%d logical", x, y);
      mu_input_mousemove(&ui, x, y); mu_input_mousedown(&ui, x, y, MU_MOUSE_LEFT); return 1;
    case AMOTION_EVENT_ACTION_MOVE:
      mu_input_mousemove(&ui, x, y); return 1;
    case AMOTION_EVENT_ACTION_UP:
    case AMOTION_EVENT_ACTION_CANCEL:
      mu_input_mouseup(&ui, x, y, MU_MOUSE_LEFT); released = 1; return 1;
    default: return 0;
  }
}

void android_main(struct android_app *app) {
  /* The panel owns the screen, as the desktop's window owns its own: without this the status bar
     sits on top of the first row and the layout has no way to know how tall it is. */
  ANativeActivity_setWindowFlags(app->activity, AWINDOW_FLAG_FULLSCREEN, 0);
  app->onAppCmd = on_command;
  /* Without this the glue drops every touch on the floor: `process_input` reads the queue and asks
     `onInputEvent`, and a null handler is a silently ignored event, not an error. */
  app->onInputEvent = on_input;
  SAY("companion: native layer up, draw-list contract v%d", RE_DRAW_LIST_VERSION);
  for (;;) {
    int events;
    struct android_poll_source *source;
    /* Blocks only while there is nothing to draw; once the renderer is up the loop is the frame
       loop, which is what decision 7 means by the C layer driving. */
    while (ALooper_pollOnce(draw ? 0 : -1, NULL, &events, (void **)&source) >= 0) {
      if (source) source->process(app, source);
      if (app->destroyRequested) { on_command(app, APP_CMD_TERM_WINDOW); return; }
    }
    if (draw && app->window) {
      /* The window's own size: the host is the backend's business, and asking Android is both
         simpler and the thing that stays right across a rotation. */
      draw_frame(ANativeWindow_getWidth(app->window), ANativeWindow_getHeight(app->window));
    }
  }
}

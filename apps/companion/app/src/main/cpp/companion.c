/* The companion's native entry (charter D57, spec 128 decisions 7, 8 and 10).
 *
 * Decision 7: the C layer drives and Rust serves. This is that C layer — it owns the frame loop
 * exactly as `app.c` does on the desktop, builds a microui frame with the desktop's own control
 * primitives, and hands the resulting draw list to `backend_seam.c`, which is the desktop's renderer
 * unchanged, running on the pack's Vulkan backend through `seam_host_android.c`.
 *
 * Nothing here is a port of the renderer. The only code in this file that the desktop also has is
 * the microui-command walk, which lives in the desktop's `draw.c` — a file still bound to SDL
 * through `draw.h`. Freeing that is the next portability step; until then this is the app's own
 * twenty lines rather than a copied module.
 */
#include <android/log.h>
#include <android/configuration.h>
#include <android/input.h>
#include <android/native_window.h>
#include <android_native_app_glue.h>

#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "draw.h"
#include "render/seam_backends.h"   /* the entry points draw.c dispatches to */
#include "render/font.h"
#include "ui/ui.h"

#define TAG "rengine.companion"
#define SAY(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

/* This binary carries ONE backend, as a game does (D14b) — the desktop is the only thing that links
   three prefixed copies. draw.c's dispatch still names all of them, so the ones not compiled in
   answer here rather than failing to link, and `--renderer vulkan` on an OpenGL build is refused
   honestly instead of being a missing symbol. Which arm is live comes from the build. */
#if !defined(RE_COMPANION_VULKAN)
ReBackend *re_vulkan_backend_seam_open(void *window, ReFontSet *fonts);
uint32_t re_vulkan_backend_seam_window_flags(void);
ReBackend *re_vulkan_backend_seam_open(void *window, ReFontSet *fonts) { (void)window; (void)fonts; return NULL; }
uint32_t re_vulkan_backend_seam_window_flags(void) { return 0; }
#endif
#if !defined(RE_COMPANION_OPENGL)
ReBackend *re_opengl_backend_seam_open(void *window, ReFontSet *fonts);
uint32_t re_opengl_backend_seam_window_flags(void);
ReBackend *re_opengl_backend_seam_open(void *window, ReFontSet *fonts) { (void)window; (void)fonts; return NULL; }
uint32_t re_opengl_backend_seam_window_flags(void) { return 0; }
#endif

static ReDraw *draw;
static mu_Context ui;
static int frames;
static double slowest_ms;
static int taps;
static float density = 1.0f;

/* The mono face every Android build has. The pinned Inter and Phosphor faces the desktop bundles
   ride in the APK's assets when the companion needs them; a system face is what makes the first
   frame stand on its own. */
static const char *MONO = "/system/fonts/DroidSansMono.ttf";

/* The theme's colours are microui's type; the draw list has its own. draw.c spells this the same
   way, and it is three fields rather than a module worth sharing. */
static ReColor color_of(mu_Color c) { return re_color(c.r, c.g, c.b, c.a); }

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec * 1000.0 + (double)t.tv_nsec / 1000000.0;
}

/* One frame, driven exactly as main.c drives one on the desktop: open the frame, build the UI with
   the owned controls, hand microui's commands to the draw glue, flush the overlay, present. */
static void draw_frame(int width, int height) {
  double started = now_ms();
  int w = (int)((float)width / density), h = (int)((float)height / density);

  re_draw_begin(draw, w, h);
  re_ui_begin(draw, started / 1000.0);
  mu_begin(&ui);
  if (mu_begin_window_ex(&ui, "rEngine companion", mu_rect(0, 0, w, h),
                         MU_OPT_NOCLOSE | MU_OPT_NORESIZE | MU_OPT_NOTITLE)) {
    /* microui remembers a window's rect by name after the first frame, which is right for a desktop
       where the person moves it and wrong for a phone where the display decides. Rotating gave a new
       surface and the same remembered rect, so the layout kept its old shape — this is that fix, and
       it is why the container is written every frame rather than only at creation. */
    mu_get_current_container(&ui)->rect = mu_rect(0, 0, w, h);
    mu_layout_row(&ui, 1, (int[]){-1}, 0);
    re_ui_label_ex(&ui, "the desktop's own control layer, on this device", RE_UI_MUTED);
    mu_layout_row(&ui, 2, (int[]){140, -1}, 0);
    re_ui_label_ex(&ui, "contract", RE_UI_MUTED);
    re_ui_label_ex(&ui, "red.v1  /red/1", 0);
    re_ui_label_ex(&ui, "renderer", RE_UI_MUTED);
    re_ui_label_ex(&ui, re_draw_backend(draw), 0);
    mu_layout_row(&ui, 1, (int[]){-1}, 0);
    re_ui_separator(&ui);
    if (re_ui_button_ex(&ui, "Sessions", RE_ICON_SHELL, RE_UI_ALIGN_LEFT)) taps++;
    if (re_ui_button_ex(&ui, "Tasks", RE_ICON_CHECK, RE_UI_ALIGN_LEFT)) taps++;
    if (re_ui_button_ex(&ui, "Approve", RE_ICON_CHECK, RE_UI_PRIMARY)) taps++;
    mu_layout_row(&ui, 1, (int[]){-1}, 0);
    char counted[64];
    snprintf(counted, sizeof(counted), "%d tap(s) — the controls answer", taps);
    re_ui_label_ex(&ui, counted, RE_UI_SMALL | RE_UI_MUTED);
    mu_end_window(&ui);
  }
  mu_end(&ui);
  re_draw_commands(draw, &ui);
  re_ui_overlay_flush(draw);
  re_draw_end(draw);

  double took = now_ms() - started;
  if (took > slowest_ms) slowest_ms = took;
  if (++frames % 120 == 0)
    SAY("companion: %d frames, slowest %.2f ms, %d tap(s)", frames, slowest_ms, taps);
}

/* Touch is microui's mouse: microui was built for a pointer, and one finger is a pointer. The
   coordinates arrive in physical pixels and the UI thinks in logical ones, so they are divided by
   the density exactly as the draw list's are multiplied by it. */
static int32_t on_input(struct android_app *app, AInputEvent *event) {
  (void)app;
  if (AInputEvent_getType(event) != AINPUT_EVENT_TYPE_MOTION) return 0;
  int32_t action = AMotionEvent_getAction(event) & AMOTION_EVENT_ACTION_MASK;
  int x = (int)(AMotionEvent_getX(event, 0) / density);
  int y = (int)(AMotionEvent_getY(event, 0) / density);
  switch (action) {
    case AMOTION_EVENT_ACTION_DOWN:
      /* A finger arrives already pressed and microui resolves hover before press, so the move has to
         land first or the first tap is delivered to whatever was hovered last — which is nothing. */
      mu_input_mousemove(&ui, x, y);
      mu_input_mousedown(&ui, x, y, MU_MOUSE_LEFT);
      break;
    case AMOTION_EVENT_ACTION_MOVE:
      mu_input_mousemove(&ui, x, y);
      break;
    case AMOTION_EVENT_ACTION_UP:
    case AMOTION_EVENT_ACTION_CANCEL:
      mu_input_mouseup(&ui, x, y, MU_MOUSE_LEFT);
      /* Leave the pointer where the finger left, not hovering: a touch UI has no hover state and a
         button that stays lit after a tap looks stuck. */
      mu_input_mousemove(&ui, -1, -1);
      break;
    default: return 0;
  }
  return 1;
}

static void on_command(struct android_app *app, int32_t command) {
  if (command == APP_CMD_WINDOW_RESIZED || command == APP_CMD_CONFIG_CHANGED) {
    /* The EGL window surface follows the native window on Android, so the per-frame size query is
       what adjusts the layout; this is here to say so in the log when a rotation happens. */
    if (app->window)
      SAY("companion: window is now %dx%d", ANativeWindow_getWidth(app->window), ANativeWindow_getHeight(app->window));
  }
  if (command == APP_CMD_INIT_WINDOW && app->window && !draw) {
    /* Android reports density in dpi buckets; 160 is the baseline a logical pixel is defined by. */
    density = (float)AConfiguration_getDensity(app->config) / 160.0f;
    if (density < 1.0f || density > 8.0f) density = 2.0f;
    /* The same entry point the desktop uses, with the window opaque above the host (charter D59).
       re_draw_bind installs the theme, the metrics and the text measurement, so the companion gets
       the product's look rather than microui's defaults without asking for it. */
    draw = re_draw_open(app->window, MONO, re_draw_select(NULL));
    if (!draw) { SAY("companion: the renderer would not open: %s", re_font_error()); return; }
    re_draw_bind(draw, &ui);
    SAY("companion: renderer up on the %s backend at density %.2f, drawing the desktop's control layer",
        re_draw_backend(draw), (double)density);
  } else if (command == APP_CMD_TERM_WINDOW && draw) {
    re_draw_close(draw);
    draw = NULL;
  }
}

void android_main(struct android_app *app) {
  app->onAppCmd = on_command;
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

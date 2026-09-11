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
#include <android/native_window.h>
#include <android_native_app_glue.h>

#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "render/backend.h"
#include "render/backend_seam.h"
#include "render/font.h"
#include "theme.h"
#include "microui.h"

#define TAG "rengine.companion"
#define SAY(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

static ReBackend *backend;
static ReFontSet *fonts;
static mu_Context ui;
static ReDrawList list;
static int frames;
static double slowest_ms;
static float density = 1.0f;

/* The mono face every Android build has. The pinned Inter and Phosphor faces the desktop bundles
   ride in the APK's assets when the companion needs them; a system face is what makes the first
   frame stand on its own. */
static const char *MONO = "/system/fonts/DroidSansMono.ttf";

static int text_width(mu_Font font, const char *s, int length) {
  (void)font;
  ReFontMetrics m = re_font_metrics(fonts, RE_FACE_MONO, RE_THEME_FONT_SIZE, density);
  return (length < 0 ? (int)strlen(s) : length) * m.advance;
}
static int text_height(mu_Font font) { (void)font; return RE_THEME_LINE_HEIGHT; }

/* The theme's colours are microui's type; the draw list has its own. draw.c spells this the same
   way, and it is three fields rather than a module worth sharing. */
static ReColor color_of(mu_Color c) { return re_color(c.r, c.g, c.b, c.a); }

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec * 1000.0 + (double)t.tv_nsec / 1000000.0;
}

/* One frame of the shared UI, built the way the desktop builds one. */
static void draw_frame(int width, int height) {
  double started = now_ms();
  /* Logical pixels, as the draw list's contract says: the backend scales by the density, exactly as
     it does for a HiDPI desktop. Without this a phone's 1080-wide panel renders desktop-sized text
     at a third of the size a thumb can use. */
  int logical_w = (int)((float)width / density), logical_h = (int)((float)height / density);
  re_draw_list_reset(&list, logical_w, logical_h, density, color_of(RE_COLOR_CANVAS));

  mu_begin(&ui);
  if (mu_begin_window_ex(&ui, "rEngine companion", mu_rect(12, 24, logical_w - 24, logical_h - 48), MU_OPT_NOCLOSE)) {
    mu_layout_row(&ui, 1, (int[]){-1}, 0);
    mu_label(&ui, "the desktop's own UI layer, on this device");
    mu_layout_row(&ui, 2, (int[]){160, -1}, 0);
    mu_label(&ui, "contract");
    mu_label(&ui, "red.v1  /red/1");
    mu_label(&ui, "renderer");
    /* The backend's own name, not a string typed here: this label was hardcoded to "vulkan" and
       displayed exactly that while running on OpenGL, which is the kind of small lie a screenshot
       makes permanent. */
    mu_label(&ui, backend->ops->name);
    mu_layout_row(&ui, 1, (int[]){-1}, 0);
    mu_button(&ui, "Sessions");
    mu_button(&ui, "Tasks");
    mu_button(&ui, "Approve");
    mu_end_window(&ui);
  }
  mu_end(&ui);

  mu_Command *command = NULL;
  while (mu_next_command(&ui, &command)) {
    ReColor color;
    ReRect rect;
    switch (command->type) {
      case MU_COMMAND_RECT:
        color = (ReColor){command->rect.color.r, command->rect.color.g, command->rect.color.b, command->rect.color.a};
        rect = (ReRect){command->rect.rect.x, command->rect.rect.y, command->rect.rect.w, command->rect.rect.h};
        re_draw_list_rect(&list, rect, color);
        break;
      case MU_COMMAND_TEXT:
        color = (ReColor){command->text.color.r, command->text.color.g, command->text.color.b, command->text.color.a};
        re_draw_list_text(&list, RE_FACE_MONO, RE_THEME_FONT_SIZE, command->text.pos.x, command->text.pos.y,
                          color, command->text.str, -1);
        break;
      case MU_COMMAND_CLIP:
        rect = (ReRect){command->clip.rect.x, command->clip.rect.y, command->clip.rect.w, command->clip.rect.h};
        re_draw_list_clip(&list, &rect);
        break;
      default: break;
    }
  }

  if (backend->ops->begin(backend, &list)) {
    backend->ops->execute(backend, &list);
    backend->ops->present(backend);
  }
  double took = now_ms() - started;
  if (took > slowest_ms) slowest_ms = took;
  if (++frames % 60 == 0)
    SAY("companion: %d frames, %zu draw-list command(s), slowest %.2f ms", frames, list.count, slowest_ms);
}

static void on_command(struct android_app *app, int32_t command) {
  if (command == APP_CMD_INIT_WINDOW && app->window && !backend) {
    /* Android reports density in dpi buckets; 160 is the baseline a logical pixel is defined by. */
    density = (float)AConfiguration_getDensity(app->config) / 160.0f;
    if (density < 1.0f || density > 8.0f) density = 2.0f;
    fonts = re_font_open(MONO, NULL);
    if (!fonts) { SAY("companion: no font at %s: %s", MONO, re_font_error()); return; }
    backend = re_backend_seam_open(app->window, fonts);
    if (!backend) { SAY("companion: the seam-backed renderer would not open"); return; }
    re_draw_list_init(&list);
    mu_init(&ui);
    ui.text_width = text_width;
    ui.text_height = text_height;
    SAY("companion: renderer up on the %s backend at density %.2f, drawing the desktop's UI layer",
        backend->ops->name, (double)density);
  } else if (command == APP_CMD_TERM_WINDOW && backend) {
    backend->ops->close(backend);
    backend = NULL;
    re_draw_list_free(&list);
    re_font_close(fonts);
    fonts = NULL;
  }
}

void android_main(struct android_app *app) {
  app->onAppCmd = on_command;
  SAY("companion: native layer up, draw-list contract v%d", RE_DRAW_LIST_VERSION);
  for (;;) {
    int events;
    struct android_poll_source *source;
    /* Blocks only while there is nothing to draw; once the renderer is up the loop is the frame
       loop, which is what decision 7 means by the C layer driving. */
    while (ALooper_pollOnce(backend ? 0 : -1, NULL, &events, (void **)&source) >= 0) {
      if (source) source->process(app, source);
      if (app->destroyRequested) { on_command(app, APP_CMD_TERM_WINDOW); return; }
    }
    if (backend && app->window) {
      /* The window's own size: the host is the backend's business, and asking Android is both
         simpler and the thing that stays right across a rotation. */
      draw_frame(ANativeWindow_getWidth(app->window), ANativeWindow_getHeight(app->window));
    }
  }
}

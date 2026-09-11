/* The companion's native entry (charter D57, spec 128 decisions 7 and 10).
 *
 * Decision 7: the C layer drives and Rust serves. This is that C layer's first breath — it builds a
 * real microui frame with the desktop's own control layer and draw list, on the device, and reports
 * what came out. No GPU yet: the Vulkan surface on the D49 device layer is the next slice, and a
 * frame that exists is the thing to prove before something draws it.
 *
 * What makes this worth running at all is where the code came from. microui, the draw list, the
 * theme and the owned control layer are compiled from their places in this repository, so a screen
 * that builds here is the screen the desktop builds. */
#include <android/log.h>
#include <android_native_app_glue.h>

#include <string.h>

#include "render/draw_list.h"
#include "theme.h"
#include "microui.h"

#define TAG "rengine.companion"
#define SAY(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

/* microui asks the host to measure text. The real font path (font.c and the pinned faces) arrives
 * with the renderer; until a frame is drawn, a fixed cell is enough to lay one out. */
static int text_width(mu_Font font, const char *text, int length) {
  (void)font;
  return (length < 0 ? (int)strlen(text) : length) * 8;
}
static int text_height(mu_Font font) { (void)font; return 20; }

/* One frame of the shared UI, built exactly as the desktop builds one: a microui context, a window,
 * controls, then the draw list the renderer would execute. */
static size_t build_one_frame(void) {
  static mu_Context ui;
  static ReDrawList list;
  mu_init(&ui);
  ui.text_width = text_width;
  ui.text_height = text_height;
  re_draw_list_init(&list);
  re_draw_list_reset(&list, 480, 320, 1.0f, (ReColor){0, 0, 0, 255});

  mu_begin(&ui);
  if (mu_begin_window(&ui, "rEngine", mu_rect(0, 0, 480, 320))) {
    mu_layout_row(&ui, 1, (int[]){-1}, 0);
    mu_label(&ui, "companion");
    mu_button(&ui, "Sessions");
    mu_end_window(&ui);
  }
  mu_end(&ui);

  /* Walk microui's commands into the draw list, which is the contract a backend executes. */
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
        re_draw_list_text(&list, RE_FACE_UI, RE_THEME_FONT_SIZE, command->text.pos.x, command->text.pos.y,
                          color, command->text.str, -1);
        break;
      case MU_COMMAND_CLIP:
        rect = (ReRect){command->clip.rect.x, command->clip.rect.y, command->clip.rect.w, command->clip.rect.h};
        re_draw_list_clip(&list, &rect);
        break;
      default: break;
    }
  }
  size_t count = list.count;
  re_draw_list_free(&list);
  return count;
}

static void on_command(struct android_app *app, int32_t command) {
  (void)app;
  if (command != APP_CMD_INIT_WINDOW) return;
  SAY("companion: window ready; building one shared-UI frame");
  SAY("companion: draw list carries %zu command(s) from the desktop's own UI layer", build_one_frame());
}

void android_main(struct android_app *app) {
  app->onAppCmd = on_command;
  SAY("companion: native layer up, draw-list contract v%d", RE_DRAW_LIST_VERSION);
  for (;;) {
    int events;
    struct android_poll_source *source;
    while (ALooper_pollOnce(-1, NULL, &events, (void **)&source) >= 0) {
      if (source) source->process(app, source);
      if (app->destroyRequested) return;
    }
  }
}

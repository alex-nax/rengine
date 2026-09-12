/* The scene, rendered in a tab (F136, spec 126 decisions 6, 7 and 8; charter D55).
 *
 * This is the plugin half. Everything that touches the GPU is the pack's own `scene.c`, compiled
 * into this module unchanged and reaching the desktop's seam through seam_forward.c — so the image
 * in the tab is produced by the same source the backend comparison judges, which is F136's third
 * criterion held by construction rather than by discipline.
 *
 * Decision 8, still by default: the plugin asks for no frames of its own. It draws when the window
 * draws, and the window draws when something happened — a pointer move over this tab, a drag, a
 * resize. The only thing that animates is the built-in scene's own frame counter, and it advances
 * only while a drag is in progress, so a Scene tab left alone costs nothing.
 */
#include "plugin_render.h"
#include "scene.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void re_scene_plugin_bind(const RePluginRender *table);   /* seam_forward.c */

#define SCENE_TABS 1

typedef struct {
  Scene scene;
  bool open;                  /* the GPU side is built */
  bool failed;
  char error[256];
  char model[1024];           /* the .obj this tab shows, or "" for the built-in scene */
  int width, height;          /* what the scene was opened at */
  /* `scene_draw` derives the camera entirely from these three: the frame number is the orbit
     angle, `orbit` the distance in radii and `eye_height` the height. So dragging moves them
     rather than a camera of the plugin's own -- there is no second camera to disagree with. */
  int frame;
  bool dragging;
  int last_x, last_y;
} SceneState;

static SceneState state;

/* The model this tab was opened for: the host says, because a plugin has no store to ask (D38) and
 * its tabs are registered at start, so the file cannot be part of the identity. Empty is the
 * built-in procedural scene, which is what decision 7's "a command opens the built-in scene, which
 * has no file" means here. RENGINE_SCENE_MODEL still works, so the example's own environment points
 * the tab at the same model the pack's gates use. */
static const char *model_path(const RePluginHost *host, RePluginFrame *frame) {
  const char *subject = host->subject(frame);
  if (subject && *subject) return subject;
  const char *given = getenv("RENGINE_SCENE_MODEL");
  return given && *given ? given : NULL;
}

static void release(const RePluginRender *render) {
  if (state.open) { scene_close(&state.scene, render->seam); state.open = false; }
  memset(&state.scene, 0, sizeof(state.scene));
}

static void draw_tab(RePluginFrame *frame, void *user) {
  const RePluginHost *host = user;
  ReRect area = host->area(frame);
  const RePluginRender *render = host->render(frame);
  ReColor ground = re_color(20, 20, 22, 255);
  host->colour(frame, "--ui-canvas", &ground);
  if (!render) {          /* a frame that cannot render says so rather than drawing nothing */
    host->rect(frame, area, ground);
    host->text(frame, 1, 12, area.x + 8, area.y + 8, re_color(200, 120, 120, 255),
               "This window cannot render: no seam in this frame.", -1);
    return;
  }
  re_scene_plugin_bind(render);   /* every re_seam_* below lands on the desktop's seam */

  int width = area.w > 0 ? area.w : 1, height = area.h > 0 ? area.h : 1;
  ReSeamTarget target;
  if (!render->target(frame, width, height, &target)) {
    host->rect(frame, area, ground);
    host->text(frame, 1, 12, area.x + 8, area.y + 8, re_color(200, 120, 120, 255),
               "No render target for this tab.", -1);
    return;
  }

  /* Pointer first, so a drag this frame is reflected in the image this frame. */
  RePluginPointer pointer = {0};
  host->pointer(frame, &pointer);
  if (pointer.inside && (pointer.buttons & RE_PLUGIN_BUTTON_LEFT)) {
    if (state.dragging && state.open) {
      state.frame += pointer.x - state.last_x;                 /* sideways swings the orbit */
      state.scene.eye_height += (float)(pointer.y - state.last_y) * 0.002f;   /* and up looks down */
      if (state.scene.eye_height > 2.0f) state.scene.eye_height = 2.0f;
      if (state.scene.eye_height < -2.0f) state.scene.eye_height = -2.0f;
    }
    state.dragging = true; state.last_x = pointer.x; state.last_y = pointer.y;
  } else {
    state.dragging = false;
  }
  if (pointer.inside && pointer.wheel_y != 0 && state.open) {
    state.scene.orbit -= pointer.wheel_y * 0.05f;
    if (state.scene.orbit < 0.02f) state.scene.orbit = 0.02f;
    if (state.scene.orbit > 12.0f) state.scene.orbit = 12.0f;
  }

  const char *model = model_path(host, frame);
  bool changed = strcmp(state.model, model ? model : "") != 0;
  if (state.open && (changed || state.width != width || state.height != height)) release(render);
  if (changed) { state.failed = false; state.error[0] = 0; }
  if (!state.open && !state.failed) {
    snprintf(state.model, sizeof(state.model), "%s", model ? model : "");
    if (scene_open(&state.scene, render->seam, width, height, model, state.error, sizeof(state.error))) {
      state.open = true; state.width = width; state.height = height;
      /* A fitted orbit frames an object from outside its bounding sphere, which is wrong for a
         building you are meant to stand in -- the example documents 0.2 and 0.02 for Sponza and
         says why (spec 124). The scene's own defaults suit the built-in one, so only a loaded
         model is re-framed, and only until the pointer says otherwise. */
      if (state.scene.loaded_model) { state.scene.orbit = 0.2f; state.scene.eye_height = 0.02f; }
    } else {
      state.failed = true;
    }
  }
  if (!state.open) {
    host->rect(frame, area, ground);
    host->text(frame, 1, 12, area.x + 8, area.y + 8, re_color(200, 120, 120, 255),
               state.error[0] ? state.error : "The scene would not open.", -1);
    return;
  }

  scene_draw(&state.scene, render->seam, target, state.frame);

  /* The target's row 0 is NDC -1, which is the seam's promise for a render target; the draw list
     puts row 0 at the top. One flip, named rather than compensated for somewhere in a shader. */
  render->draw_target(frame, area, RE_DRAW_FLIP_Y);

  char label[256];
  const char *shown = state.model[0] ? state.model : "built-in scene";
  const char *leaf = strrchr(shown, '/');
  snprintf(label, sizeof(label), "%s · %zu vertices · %zu parts", leaf ? leaf + 1 : shown,
           state.scene.geometry.vertex_count, state.scene.geometry.part_count);
  ReColor muted = re_color(150, 150, 155, 255);
  host->colour(frame, "--ui-fg-muted", &muted);
  host->text(frame, 1, 11, area.x + 8, area.y + area.h - 18, muted, label, -1);
}

static const RePluginHost *saved_host;
static bool start(RePlugin *self, const RePluginHost *host, void **user) {
  saved_host = host;
  *user = (void *)(uintptr_t)host;   /* the draw callback's `state` is the host table itself */
  RePluginTab tab = {(uint32_t)sizeof(RePluginTab), "view", "Scene", draw_tab};
  return host->register_tab(self, &tab);
}
static void stop(RePlugin *self, void *user) {
  (void)self; (void)user;
  /* The window is closing and the seam is going with it; the handles are the host's to drop. */
  state.open = false;
  memset(&state, 0, sizeof(state));
  saved_host = NULL;
}

static const RePluginDesc desc = {
  (uint32_t)sizeof(RePluginDesc), RE_PLUGIN_ABI_VERSION, RE_DRAW_LIST_VERSION,
  "scene", "1.0.0", start, stop,
};
RE_PLUGIN_EXPORT const RePluginDesc *re_plugin_entry(void) { return &desc; }

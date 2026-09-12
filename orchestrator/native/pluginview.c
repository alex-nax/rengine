#include "pluginview.h"
#include "plugin_render.h"

static int measure(void *context, uint8_t face, int size, const char *text, int length) {
  return re_draw_text_width(context, face, size, text, length);
}
int re_app_plugin_load(ReApp *a, const char *name, const char *path, const char *abi) {
  char error[512];
  int index = re_plugins_load(a->plugins, name, path, abi, error, sizeof(error));
  if (index < 0) { snprintf(a->status, sizeof(a->status), "Plugin refused: %s", error); return -1; }
  for (int k = 0; k < re_plugins_tab_count(a->plugins, index); k++)
    re_app_tab(a, RE_PLUGIN, "", re_plugins_tab_identity(a->plugins, index, k), "", re_plugins_tab_title(a->plugins, index, k));
  return index;
}

/* ---- the render extension's host half (charter D55, spec 126 decision 9) --------------------
 *
 * One target per plugin tab, owned here. D55 says a target is "requested by size each frame and
 * returned as a handle good for that frame only", and the frame scope is what plugin.c enforces:
 * `draw_target` refuses unless this frame asked. What is NOT per frame is the allocation — a depth
 * buffer rebuilt sixty times a second would cost more than the scene — so the same size gives the
 * same target back, and a resize or a renderer change throws it away. The renderer is identified by
 * the draw context: a different ReDraw means a different device, and every handle here belonged to
 * the old one.
 */
typedef struct {
  char identity[RE_PLUGIN_IDENTITY_MAX];
  ReDraw *owner;                       /* which window/renderer these handles belong to */
  uint32_t color, depth, target;       /* seam ids */
  int width, height;
  ReTexture *composite;                /* the colour, wrapped so the draw list can sample it */
} PluginPass;

static PluginPass passes[RE_TABS];

static void pass_release(PluginPass *pass) {
  const struct RePluginRender *table = pass->owner ? re_draw_plugin_table(pass->owner) : NULL;
  struct ReSeam *seam = pass->owner ? re_draw_seam(pass->owner) : NULL;
  if (table && seam) {
    ReSeamTarget target = {pass->target, pass->width, pass->height};
    ReSeamTexture color = {pass->color, pass->width, pass->height};
    ReSeamTexture depth = {pass->depth, pass->width, pass->height};
    if (pass->target) table->target_destroy(seam, &target);
    if (pass->color) table->texture_destroy(seam, &color);
    if (pass->depth) table->texture_destroy(seam, &depth);
  }
  if (pass->composite) re_draw_texture_destroy(pass->composite);
  memset(pass, 0, sizeof(*pass));
}

/* What the two callbacks below receive: which window renders, and which tab is being framed. */
typedef struct { ReDraw *draw; const char *identity; } PassContext;

static PluginPass *pass_for(const char *identity, ReDraw *draw) {
  PluginPass *free_slot = NULL;
  for (int i = 0; i < RE_TABS; i++) {
    if (passes[i].owner && !strcmp(passes[i].identity, identity)) {
      if (passes[i].owner == draw) return &passes[i];
      pass_release(&passes[i]);           /* another renderer's handles; none of them survive */
    }
    if (!free_slot && !passes[i].owner) free_slot = &passes[i];
  }
  return free_slot;
}

static bool pass_target(void *context, int width, int height, uint32_t *color, uint32_t *target_id) {
  const PassContext *ctx = context; ReDraw *draw = ctx->draw;
  PluginPass *pass = pass_for(ctx->identity, draw);
  if (!pass) return false;
  if (pass->owner && (pass->width != width || pass->height != height)) pass_release(pass);
  if (!pass->owner) {
    const struct RePluginRender *table = re_draw_plugin_table(draw);
    struct ReSeam *seam = re_draw_seam(draw);
    if (!table || !seam) return false;
    ReSeamTexture c = table->texture_2d_for(seam, NULL, width, height, RE_SEAM_FILTER_LINEAR,
                                            RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_COLOR);
    ReSeamTexture d = table->texture_2d_for(seam, NULL, width, height, RE_SEAM_FILTER_NEAREST,
                                            RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_DEPTH);
    ReSeamTarget t = table->target_make(seam, c, d);
    if (!c.id || !d.id || !t.id) {
      ReSeamTarget rollback = t;
      if (t.id) table->target_destroy(seam, &rollback);
      if (c.id) table->texture_destroy(seam, &c);
      if (d.id) table->texture_destroy(seam, &d);
      return false;
    }
    re_copy(pass->identity, sizeof(pass->identity), ctx->identity);
    pass->owner = draw; pass->color = c.id; pass->depth = d.id; pass->target = t.id;
    pass->width = width; pass->height = height;
    pass->composite = re_draw_texture_adopt(draw, c.id, width, height);
    if (!pass->composite) { pass_release(pass); return false; }
  }
  *color = pass->color; *target_id = pass->target;
  return true;
}

static bool pass_draw_target(void *context, ReDrawList *list, ReRect rect, uint8_t flags) {
  const PassContext *ctx = context; ReDraw *draw = ctx->draw;
  PluginPass *pass = pass_for(ctx->identity, draw);
  if (!pass || !pass->composite) return false;
  return re_draw_list_texture(list, pass->composite, rect, flags);
}

void re_app_plugin_passes_release(ReApp *a) {
  (void)a;
  for (int i = 0; i < RE_TABS; i++) if (passes[i].owner) pass_release(&passes[i]);
}

/* ---- the Scene tab (spec 126 decision 7, F136) ---------------------------------------------- */

/* rEngine's own scene plugin, which ships beside the binary rather than being declared by a
 * project: decision 1 is "rEngine's own scene first". RENGINE_SCENE_PLUGIN overrides it, because a
 * derived path is a guess about the install layout and an explicit input never is. */
static bool scene_module(char *out, size_t size) {
  const char *given = getenv("RENGINE_SCENE_PLUGIN");
  if (given && *given) { re_copy(out, size, given); return true; }
  char *base = SDL_GetBasePath();
  if (!base) return false;
#if defined(_WIN32)
  const char *extension = "dll";
#elif defined(__APPLE__)
  const char *extension = "dylib";
#else
  const char *extension = "so";
#endif
  /* The binary sits in bin/ and the modules in plugins/, side by side, which is what the build
     produces and what an install keeps. */
  snprintf(out, size, "%s../plugins/rengine_plugin_scene.%s", base, extension);
  SDL_free(base);
  return true;
}

bool re_app_scene_open(ReApp *a, const char *root, const char *path) {
  char module[1200];
  if (!scene_module(module, sizeof(module))) {
    re_copy(a->status, sizeof(a->status), "Cannot locate the scene plugin: set RENGINE_SCENE_PLUGIN."); return false;
  }
  if (re_app_plugin_load(a, "scene", module, RE_PLUGIN_ABI_STRING) < 0) return false;   /* reason already in the status */
  /* The absolute path, because a plugin opens the file itself and has no root to resolve against. */
  char absolute[1024] = {0};
  if (path && *path) {
    const char *root_path = NULL; const cJSON *entry;
    cJSON_ArrayForEach(entry, cJSON_GetObjectItemCaseSensitive(a->state, "roots"))
      if (!strcmp(re_string(entry, "id"), root)) root_path = re_string(entry, "path");
    if (!root_path) { re_copy(a->status, sizeof(a->status), "That project is not in this workspace."); return false; }
    if (snprintf(absolute, sizeof(absolute), "%s/%s", root_path, path) >= (int)sizeof(absolute)) {
      re_copy(a->status, sizeof(a->status), "That path is too long for a scene."); return false;
    }
  }
  for (int i = 0; i < RE_TABS; i++) {
    ReTab *t = &a->tabs[i];
    if (!t->used || t->type != RE_PLUGIN || strcmp(t->path, "scene/view")) continue;
    re_copy(t->subject, sizeof(t->subject), absolute);
    re_app_tab(a, RE_PLUGIN, t->root, t->path, t->session, t->title);   /* brings it forward */
    snprintf(a->status, sizeof(a->status), "Scene: %s", *absolute ? absolute : "the built-in scene");
    return true;
  }
  re_copy(a->status, sizeof(a->status), "The scene plugin registered no view.");
  return false;
}

/* A restored tab whose plugin is not loaded in this window says so rather than drawing nothing:
 * the layout keeps the view, the module arrives when the declaration does (spec 106 decision 10). */
void re_plugin_view_draw(ReApp *a, ReTab *t, ReDraw *draw) {
  ReRect area = re_rect(t->rect.x, t->rect.y, t->rect.w, t->rect.h);
  PassContext ctx = {draw, t->path};
  RePluginRenderer renderer = {
    .table = re_draw_plugin_table(draw), .seam = re_draw_seam(draw),
    .target = pass_target, .draw_target = pass_draw_target, .context = &ctx,
  };
  RePluginFrameSpec spec = {
    .list = re_draw_list(draw), .area = area, .measure = measure, .context = draw,
    .renderer = renderer.table && renderer.seam ? &renderer : NULL,
    .subject = t->subject,
  };
  /* Pointer and focus, scoped to this tab (charter D55): a plugin learns nothing about any other. */
  bool inside = re_inside(t->rect, a->mouse_x, a->mouse_y);
  spec.pointer.size = (uint32_t)sizeof(spec.pointer);
  spec.pointer.inside = inside;
  spec.pointer.focused = a->focus == (int)(t - a->tabs);
  if (inside) {
    spec.pointer.x = a->mouse_x - t->rect.x; spec.pointer.y = a->mouse_y - t->rect.y;
    spec.pointer.buttons = a->plugin_buttons;
    spec.pointer.wheel_x = t->plugin_wheel_x; spec.pointer.wheel_y = t->plugin_wheel_y;
  }
  t->plugin_wheel_x = t->plugin_wheel_y = 0;   /* steps are since the plugin's previous frame */
  if (re_plugins_draw(a->plugins, t->path, &spec)) return;
  char text[192]; snprintf(text, sizeof(text), "Plugin view %s is not loaded in this window.", t->path);
  re_draw_text_face(draw, RE_FACE_UI, RE_METRIC_DESIGN_SIZE, text, -1, t->rect.x + RE_METRIC_DESIGN_PAD, t->rect.y + RE_METRIC_DESIGN_PAD, RE_COLOR_TEXT_MUTED);
}

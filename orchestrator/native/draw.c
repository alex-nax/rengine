#include "draw.h"
#include "render/backend_sdl.h"
#include "render/backend_gl.h"
#include "render/backend_vk.h"
#include "render/backend_seam.h"
#ifdef __APPLE__
#include "render/backend_metal.h"
#endif

#define RE_STAT_FRAMES 120
#ifdef __APPLE__
#define RE_DEFAULT_BACKEND "metal" /* spec 072 decision 2; OpenGL stays selectable */
#else
#define RE_DEFAULT_BACKEND "sdl"    /* Windows keeps SDL until it has its own evidence (KI-014) */
#endif

struct ReDraw {
  ReBackend *backend; ReFontSet *fonts; ReDrawList list; mu_Context *ui;
  int cell_width, line_height; float density; bool flushed;
  double build[RE_STAT_FRAMES], execute[RE_STAT_FRAMES]; int stat_count, stat_next; Uint64 frame_start;
};
static ReDraw *active;

static ReColor color_of(mu_Color c) { return re_color(c.r, c.g, c.b, c.a); }
static ReRect rect_of(mu_Rect r) { return re_rect(r.x, r.y, r.w, r.h); }

static int text_width(mu_Font font, const char *s, int length) {
  ReDraw *d = font; int count = 0;
  const char *end = s + (length < 0 ? strlen(s) : (size_t)length);
  while (*s && s < end) { re_utf8(&s); count++; }
  return count * d->cell_width;
}
static int text_height(mu_Font font) { return ((ReDraw *)font)->line_height; }

static void measure(ReDraw *d) {
  ReFontMetrics m = re_font_metrics(d->fonts, RE_FACE_MONO, RE_THEME_FONT_SIZE, d->density);
  d->cell_width = m.advance; d->line_height = RE_THEME_LINE_HEIGHT;
}
const char *re_draw_select(const char *name) {
  const char *choice = name && *name ? name : getenv("RENGINE_RENDERER");
  if (!choice || !*choice) choice = RE_DEFAULT_BACKEND;
  if (!strcmp(choice, "opengl")) return "opengl";
#ifdef __APPLE__
  if (!strcmp(choice, "metal")) return "metal";
#endif
  if (!strcmp(choice, "vulkan")) return "vulkan";
  /* The draw list through the pack's seam (F133). Selectable alongside the hand-written backends
     for the length of the transition, so the suite can judge it against them before they go. */
  if (!strcmp(choice, "seam")) return "seam";
  return !strcmp(choice, "sdl") ? "sdl" : NULL;
}
Uint32 re_draw_window_flags(const char *backend) {
  if (backend && !strcmp(backend, "opengl")) return re_backend_gl_window_flags();
#ifdef __APPLE__
  if (backend && !strcmp(backend, "metal")) return re_backend_metal_window_flags();
#endif
  if (backend && !strcmp(backend, "vulkan")) return re_backend_vk_window_flags();
  if (backend && !strcmp(backend, "seam")) return re_backend_seam_window_flags();
  return 0;
}
ReDraw *re_draw_active(void) { return active; }
ReDraw *re_draw_open(SDL_Window *window, const char *font_path, const char *backend) {
  ReDraw *d = calloc(1, sizeof(*d));
  if (!d) return NULL;
  d->fonts = re_font_open(font_path, getenv("RENGINE_UI_FONT"));
  if (!d->fonts) { SDL_SetError("%s", re_font_error()); free(d); return NULL; }
#ifdef __APPLE__
  if (backend && !strcmp(backend, "metal")) d->backend = re_backend_metal_open(window, d->fonts);
  else
#endif
  if (backend && !strcmp(backend, "vulkan")) d->backend = re_backend_vk_open(window, d->fonts);
  else if (backend && !strcmp(backend, "seam")) d->backend = re_backend_seam_open(window, d->fonts);
  else
  d->backend = backend && !strcmp(backend, "opengl") ? re_backend_gl_open(window, d->fonts) : re_backend_sdl_open(window, d->fonts);
  if (!d->backend) { re_font_close(d->fonts); free(d); return NULL; }
  re_draw_list_init(&d->list);
  int width, height; SDL_GetWindowSize(window, &width, &height);
  d->density = d->backend->ops->density(d->backend, width);
  measure(d); active = d;
  return d;
}
void re_draw_close(ReDraw *d) {
  if (!d) return;
  re_draw_list_free(&d->list);
  if (d->backend) d->backend->ops->close(d->backend);
  re_font_close(d->fonts); if (active == d) active = NULL; free(d);
}
void re_draw_bind(ReDraw *d, mu_Context *ui) {
  d->ui = ui;
  mu_init(ui); ui->text_width = text_width; ui->text_height = text_height; ui->style->font = d;
  re_theme_apply(ui->style); ui->style->size.y = d->line_height; /* generated palette/metrics; see sidecar: generated-theme */
}
/* A preset assigns the live theme and pushes it back into microui's style; the next frame draws it. */
int re_draw_theme(ReDraw *d, const char *preset) {
  int index = re_theme_select(preset);
  if (index >= 0 && d && d->ui) { re_theme_apply(d->ui->style); d->ui->style->size.y = d->line_height; }
  return index;
}
void re_draw_begin(ReDraw *d, int w, int h) {
  float density = d->backend->ops->density(d->backend, w);
  if (density != d->density) { d->density = density; measure(d); }
  re_draw_list_reset(&d->list, w, h, density, color_of(RE_COLOR_CANVAS));
  d->flushed = false; d->frame_start = SDL_GetPerformanceCounter();
}
/* Every frame flushes once; snapshot and end share it — see sidecar: deferred-flush */
static void flush(ReDraw *d) {
  if (d->flushed) return;
  d->flushed = true;
  Uint64 started = SDL_GetPerformanceCounter();
  if (d->backend->ops->begin(d->backend, &d->list)) d->backend->ops->execute(d->backend, &d->list);
  if (d->frame_start) {
    double ms = 1000.0 / (double)SDL_GetPerformanceFrequency();
    d->build[d->stat_next] = (double)(started - d->frame_start) * ms; d->execute[d->stat_next] = (double)(SDL_GetPerformanceCounter() - started) * ms;
    d->stat_next = (d->stat_next + 1) % RE_STAT_FRAMES; if (d->stat_count < RE_STAT_FRAMES) d->stat_count++;
  }
}
static double median(const double *values, int count) {
  double sorted[RE_STAT_FRAMES]; memcpy(sorted, values, sizeof(double) * (size_t)count);
  for (int i = 1; i < count; i++) { double v = sorted[i]; int j = i; while (j > 0 && sorted[j - 1] > v) { sorted[j] = sorted[j - 1]; j--; } sorted[j] = v; }
  return !count ? 0 : count % 2 ? sorted[count / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
}
cJSON *re_draw_stats(const ReDraw *d) {
  double frames[RE_STAT_FRAMES];
  for (int i = 0; i < d->stat_count; i++) frames[i] = d->build[i] + d->execute[i];
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "backend", d->backend->ops->name); cJSON_AddNumberToObject(j, "frames", d->stat_count);
  cJSON_AddNumberToObject(j, "buildMedianMs", median(d->build, d->stat_count)); cJSON_AddNumberToObject(j, "executeMedianMs", median(d->execute, d->stat_count));
  cJSON_AddNumberToObject(j, "frameMedianMs", median(frames, d->stat_count)); cJSON_AddNumberToObject(j, "commands", (double)d->list.count);
  cJSON_AddBoolToObject(j, "overflow", d->list.overflow); return j;
}
void re_draw_stats_reset(ReDraw *d) { d->stat_count = d->stat_next = 0; }
void re_draw_end(ReDraw *d) { flush(d); d->backend->ops->present(d->backend); }
bool re_draw_snapshot(ReDraw *d, const char *path) { flush(d); return d->backend->ops->snapshot(d->backend, path); }

void re_draw_rect(ReDraw *d, mu_Rect r, mu_Color c) { re_draw_list_rect(&d->list, rect_of(r), color_of(c)); }
void re_draw_clip(ReDraw *d, const mu_Rect *r) {
  if (!r) { re_draw_list_clip(&d->list, NULL); return; }
  ReRect rect = rect_of(*r); re_draw_list_clip(&d->list, &rect);
}
void re_draw_text(ReDraw *d, const char *s, int length, int x, int y, mu_Color color) {
  re_draw_list_text(&d->list, RE_FACE_MONO, RE_THEME_FONT_SIZE, x, y, color_of(color), s, length);
}
void re_draw_text_face(ReDraw *d, uint8_t face, int size, const char *s, int length, int x, int y, mu_Color color) {
  re_draw_list_text(&d->list, face, size > 0 ? size : RE_THEME_FONT_SIZE, x, y, color_of(color), s, length);
}
void re_draw_rrect(ReDraw *d, mu_Rect r, mu_Color c, float radius, uint8_t corners) { re_draw_list_rrect(&d->list, rect_of(r), color_of(c), radius, corners); }
void re_draw_frame(ReDraw *d, mu_Rect r, mu_Color border, mu_Color highlight, float radius) { re_draw_list_frame(&d->list, rect_of(r), color_of(border), color_of(highlight), radius); }
void re_draw_shadow(ReDraw *d, mu_Rect r, mu_Color c, float radius, int width) { re_draw_list_shadow(&d->list, rect_of(r), color_of(c), radius, width); }
void re_draw_ring(ReDraw *d, mu_Rect r, mu_Color c, float radius, int width) { re_draw_list_ring(&d->list, rect_of(r), color_of(c), radius, width); }
void re_draw_gradient(ReDraw *d, mu_Rect r, mu_Color from, mu_Color to, float radius, uint8_t corners, uint8_t axis) {
  re_draw_list_gradient(&d->list, rect_of(r), color_of(from), color_of(to), radius, corners, axis);
}
void re_draw_icon(ReDraw *d, uint8_t icon, mu_Rect r, mu_Color c) { re_draw_list_icon(&d->list, icon, RE_THEME_FONT_SIZE, rect_of(r), color_of(c)); }
void re_draw_icon_sized(ReDraw *d, uint8_t icon, int size, mu_Rect r, mu_Color c) {
  re_draw_list_icon(&d->list, icon, size > 0 ? size : RE_THEME_FONT_SIZE, rect_of(r), color_of(c));
}

ReTexture *re_draw_texture_create(ReDraw *d, int width, int height) { return d->backend->ops->texture_create(d->backend, width, height); }
bool re_draw_texture_update(ReTexture *t, const void *rgba, int pitch) { return t && t->owner->ops->texture_update(t, rgba, pitch); }
void re_draw_texture_destroy(ReTexture *t) { if (t) t->owner->ops->texture_destroy(t); }
void re_draw_texture(ReDraw *d, ReTexture *t, mu_Rect r, uint8_t flags) { re_draw_list_texture(&d->list, t, rect_of(r), flags); }

void re_draw_commands(ReDraw *d, mu_Context *ui) {
  mu_Command *cmd = NULL;
  while (mu_next_command(ui, &cmd)) {
    if (cmd->type == MU_COMMAND_RECT) re_draw_rect(d, cmd->rect.rect, cmd->rect.color);
    else if (cmd->type == MU_COMMAND_CLIP) re_draw_clip(d, &cmd->clip.rect);
    else if (cmd->type == MU_COMMAND_TEXT) re_draw_text(d, cmd->text.str, -1, cmd->text.pos.x, cmd->text.pos.y, cmd->text.color);
    else if (cmd->type == MU_COMMAND_ICON) {
      /* microui icons stay text runs centred with the theme metrics; RE_CMD_ICON serves the owned control layer. */
      const char *icons[] = {"?", "x", "+", ">", "v"};
      int id = cmd->icon.id; const char *s = id >= 0 && id < RE_ARRAY_SIZE(icons) ? icons[id] : "?";
      re_draw_text(d, s, -1, cmd->icon.rect.x + (cmd->icon.rect.w - d->cell_width) / 2,
                   cmd->icon.rect.y + (cmd->icon.rect.h - d->line_height) / 2, cmd->icon.color);
    }
  }
  re_draw_clip(d, NULL);
}
int re_draw_text_width(ReDraw *d, uint8_t face, int size, const char *text, int length) {
  if (!d || !text) return 0;
  return re_font_text_width(d->fonts, face, size, d->density, text, length < 0 ? (int)strlen(text) : length);
}
int re_draw_cell_width(const ReDraw *d) { return d->cell_width; }
int re_draw_line_height(const ReDraw *d) { return d->line_height; }
bool re_draw_overflowed(const ReDraw *d) { return d->list.overflow; }
ReDrawList *re_draw_list(ReDraw *d) { return &d->list; }
const char *re_draw_backend(const ReDraw *d) { return d->backend->ops->name; }

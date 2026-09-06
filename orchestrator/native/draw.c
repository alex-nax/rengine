#include "draw.h"
#include "render/backend_sdl.h"

struct ReDraw {
  ReBackend *backend; ReFontSet *fonts; ReDrawList list;
  int cell_width, line_height; float density; bool flushed;
};

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
ReDraw *re_draw_open(SDL_Window *window, const char *font_path) {
  ReDraw *d = calloc(1, sizeof(*d));
  if (!d) return NULL;
  d->fonts = re_font_open(font_path, getenv("RENGINE_UI_FONT"));
  if (!d->fonts) { SDL_SetError("%s", re_font_error()); free(d); return NULL; }
  d->backend = re_backend_sdl_open(window, d->fonts);
  if (!d->backend) { re_font_close(d->fonts); free(d); return NULL; }
  re_draw_list_init(&d->list);
  int width, height; SDL_GetWindowSize(window, &width, &height);
  d->density = d->backend->ops->density(d->backend, width);
  measure(d);
  return d;
}
void re_draw_close(ReDraw *d) {
  if (!d) return;
  re_draw_list_free(&d->list);
  if (d->backend) d->backend->ops->close(d->backend);
  re_font_close(d->fonts); free(d);
}
void re_draw_bind(ReDraw *d, mu_Context *ui) {
  mu_init(ui); ui->text_width = text_width; ui->text_height = text_height; ui->style->font = d;
  re_theme_apply(ui->style); ui->style->size.y = d->line_height; /* generated palette/metrics; see sidecar: generated-theme */
}
void re_draw_begin(ReDraw *d, int w, int h) {
  float density = d->backend->ops->density(d->backend, w);
  if (density != d->density) { d->density = density; measure(d); }
  re_draw_list_reset(&d->list, w, h, density, color_of(RE_COLOR_CANVAS));
  d->flushed = false;
}
/* Every frame flushes once; snapshot and end share it — see sidecar: deferred-flush */
static void flush(ReDraw *d) {
  if (d->flushed) return;
  d->flushed = true;
  if (d->backend->ops->begin(d->backend, &d->list)) d->backend->ops->execute(d->backend, &d->list);
}
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
void re_draw_icon(ReDraw *d, uint8_t icon, mu_Rect r, mu_Color c) { re_draw_list_icon(&d->list, icon, RE_THEME_FONT_SIZE, rect_of(r), color_of(c)); }

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
int re_draw_cell_width(const ReDraw *d) { return d->cell_width; }
int re_draw_line_height(const ReDraw *d) { return d->line_height; }
bool re_draw_overflowed(const ReDraw *d) { return d->list.overflow; }
const char *re_draw_backend(const ReDraw *d) { return d->backend->ops->name; }

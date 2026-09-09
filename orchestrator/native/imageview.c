#include "imageview.h"
#include "app.h"
#include "ui/ui.h"
#include <ctype.h>
#define STB_IMAGE_IMPLEMENTATION
#define STBI_ONLY_PNG
#define STBI_ONLY_JPEG
#define STBI_ONLY_GIF
#define STBI_NO_STDIO
#define STBI_MAX_DIMENSIONS 8192
#include "stb_image.h"

struct ReImageView {
  unsigned char *rgba; ReTexture *texture;
  int width, height, x, y; bool actual, upload_failed;
  mu_Rect rect;
};
bool re_image_path(const char *path) {
  const char *dot = strrchr(path, '.'); if (!dot || strlen(dot) > 5) return false;
  char extension[6]; size_t i;
  for (i = 0; dot[i]; i++) extension[i] = (char)tolower((unsigned char)dot[i]); extension[i] = 0;
  return !strcmp(extension, ".png") || !strcmp(extension, ".apng") || !strcmp(extension, ".jpg") ||
    !strcmp(extension, ".jpeg") || !strcmp(extension, ".gif") || !strcmp(extension, ".webp");
}
ReImageView *re_image_open(void) { return calloc(1, sizeof(ReImageView)); }
void re_image_clear(ReImageView *v) {
  if (!v) return;
  stbi_image_free(v->rgba); v->rgba = NULL;
  re_draw_texture_destroy(v->texture); v->texture = NULL;
  v->width = v->height = v->x = v->y = 0; v->upload_failed = false;
}
void re_image_close(ReImageView *v) { if (v) { re_image_clear(v); free(v); } }
bool re_image_load(ReImageView *v, const void *bytes, size_t size, char *error, size_t capacity) {
  re_image_clear(v); int w = 0, h = 0, channels = 0;
  if (!v || !bytes || !size || size > 8 * 1024 * 1024) { re_copy(error, capacity, "Image exceeds the 8 MiB limit or is empty."); return false; }
  if (size >= 12 && !memcmp(bytes, "RIFF", 4) && !memcmp((const char *)bytes + 8, "WEBP", 4)) {
    re_copy(error, capacity, "WebP decoding is not available in the native image viewer. Use PNG, JPEG or GIF."); return false;
  }
  if (!stbi_info_from_memory(bytes, (int)size, &w, &h, &channels) || w <= 0 || h <= 0 || w > 8192 || h > 8192 || (size_t)w * h > 16777216) {
    re_copy(error, capacity, "Invalid image header or image exceeds 8192 pixels per axis / 16 megapixels."); return false;
  }
  unsigned char *rgba = stbi_load_from_memory(bytes, (int)size, &w, &h, &channels, 4);
  if (!rgba) { re_copy(error, capacity, "Cannot decode this image. Refresh after repairing the file."); return false; }
  v->rgba = rgba; v->width = w; v->height = h; error[0] = 0; return true;
}
void re_image_actual(ReImageView *v, bool actual) { if (v) { v->actual = actual; v->x = v->y = 0; } }
bool re_image_is_actual(const ReImageView *v) { return v && v->actual; }
void re_image_event(ReImageView *v, const SDL_Event *e) {
  if (!v || !v->actual || e->type != SDL_MOUSEWHEEL) return;
  float dx = e->wheel.preciseX, dy = e->wheel.preciseY;
  if (SDL_GetModState() & KMOD_SHIFT) { dx += dy; dy = 0; }
  v->x = re_max(0, re_min(re_max(0, v->width - v->rect.w), v->x + (int)(dx * RE_METRIC_DESIGN_TREE_ROW)));
  v->y = re_max(0, re_min(re_max(0, v->height - v->rect.h), v->y - (int)(dy * RE_METRIC_DESIGN_TREE_ROW)));
}
void re_image_draw(ReImageView *v, ReDraw *draw, mu_Rect r) {
  if (!v || r.w <= 0 || r.h <= 0) return; v->rect = r;
  re_draw_clip(draw, &r);
  const int cell = RE_METRIC_IMAGE_CHECKER_CELL;
  for (int y = 0; y < r.h; y += cell) for (int x = 0; x < r.w; x += cell)
    re_draw_rect(draw, mu_rect(r.x + x, r.y + y, re_min(cell, r.w - x), re_min(cell, r.h - y)),
      ((x / cell + y / cell) & 1) ? RE_COLOR_TABS_BG : RE_COLOR_TERMINAL_BG);
  if (v->rgba && !v->texture && !v->upload_failed) {
    v->texture = re_draw_texture_create(draw, v->width, v->height);
    if (v->texture && re_draw_texture_update(v->texture, v->rgba, v->width * 4)) { stbi_image_free(v->rgba); v->rgba = NULL; }
    else { re_draw_texture_destroy(v->texture); v->texture = NULL; v->upload_failed = true; stbi_image_free(v->rgba); v->rgba = NULL; }
  }
  if (v->texture) {
    float scale = v->actual ? 1.0f : fminf((float)r.w / v->width, (float)r.h / v->height);
    int w = re_max(1, (int)(v->width * scale)), h = re_max(1, (int)(v->height * scale));
    v->x = re_min(v->x, re_max(0, w - r.w)); v->y = re_min(v->y, re_max(0, h - r.h));
    re_draw_texture(draw, v->texture, mu_rect(r.x + re_max(0, (r.w - w) / 2) - v->x, r.y + re_max(0, (r.h - h) / 2) - v->y, w, h), 0);
  } else if (v->upload_failed) re_draw_text(draw, "Image texture upload failed. Refresh to retry.", -1, r.x, r.y, RE_COLOR_TERMINAL_FG);
  re_draw_clip(draw, NULL);
}
void re_image_dimensions(const ReImageView *v, char *text, size_t size) {
  if (v && v->width) snprintf(text, size, "%d × %d", v->width, v->height); else re_copy(text, size, "Image");
}
cJSON *re_image_inspect(const ReImageView *v) {
  cJSON *j = cJSON_CreateObject(); cJSON_AddNumberToObject(j, "width", v->width); cJSON_AddNumberToObject(j, "height", v->height);
  cJSON_AddBoolToObject(j, "actual", v->actual); cJSON_AddBoolToObject(j, "uploaded", v->texture != NULL);
  cJSON_AddNumberToObject(j, "x", v->x); cJSON_AddNumberToObject(j, "y", v->y); return j;
}
void re_image_ui(ReApp *a, mu_Context *ui, int tab, mu_Rect content) {
  ReTab *t = &a->tabs[tab]; char dimensions[64]; re_image_dimensions(t->image, dimensions, sizeof(dimensions));
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_EDITOR_TOOLBAR_HEIGHT); re_ui_label_ex(ui, t->path, RE_UI_MUTED);
  mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_EDITOR_TOOLBAR_HEIGHT); re_ui_label_ex(ui, dimensions, RE_UI_MUTED);
  int cell_width = re_min(RE_METRIC_EDITOR_DISCARD_WIDTH, re_max(1, (content.w - 2 * RE_METRIC_EDITOR_INSET - 2 * ui->style->spacing) / 3));
  mu_layout_row(ui, 3, (int[]){cell_width, cell_width, cell_width}, RE_METRIC_EDITOR_TOOLBAR_HEIGHT);
  if (re_ui_button_ex(ui, "Fit", RE_ICON_UNKNOWN, re_image_is_actual(t->image) ? RE_UI_GHOST : RE_UI_ON)) {
    re_image_actual(t->image, false); re_app_layout_changed(a);
  }
  re_app_control(a, ui, "image-fit", "", tab);
  if (re_ui_button_ex(ui, "100%", RE_ICON_UNKNOWN, re_image_is_actual(t->image) ? RE_UI_ON : RE_UI_GHOST)) {
    re_image_actual(t->image, true); re_app_layout_changed(a);
  }
  re_app_control(a, ui, "image-actual", "", tab);
  if (re_ui_button_ex(ui, "Refresh", RE_ICON_UNKNOWN, RE_UI_GHOST)) re_app_load(a, tab);
  re_app_control(a, ui, "image-refresh", "", tab);
  if (*t->error) { mu_layout_row(ui, 1, (int[]){-1}, RE_METRIC_EDITOR_TOOLBAR_HEIGHT); mu_text(ui, t->error); t->rect = mu_rect(0, 0, 0, 0); return; }
  int top = RE_METRIC_EDITOR_TOP + 2 * RE_METRIC_FORMAT_ROW_ADVANCE + (*t->error ? RE_METRIC_EDITOR_ERROR_HEIGHT : 0);
  t->rect = mu_rect(content.x + RE_METRIC_EDITOR_INSET, content.y + top,
    re_max(0, content.w - 2 * RE_METRIC_EDITOR_INSET), re_max(0, content.h - top - RE_METRIC_EDITOR_ERROR_INSET));
}

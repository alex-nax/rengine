#include "ui/ui.h"
#include "theme.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

static int re_min_int(int a, int b) { return a < b ? a : b; }
static int re_max_int(int a, int b) { return a > b ? a : b; }

/* Hover and focus move over RE_METRIC_DESIGN_TRANSITION_MS; the table is fixed and frame-stamped,
 * so a control that stops being drawn simply loses its slot — see sidecar: transition-clock */
#define RE_UI_TRANSITIONS 256
#define RE_UI_TRANSITION_SECONDS 0.09

typedef struct { mu_Id id; float value; double seen; } Transition;

/* Overlay recording. The controls draw straight into the draw list, which is right for a workspace
 * built before microui replays, and wrong for a surface that must sit above it. Between
 * re_ui_overlay_begin and _end the primitives are recorded here instead and replayed by the flush
 * — see sidecar: overlay-layer */
enum { OVERLAY_RECT, OVERLAY_RRECT, OVERLAY_FRAME, OVERLAY_RING, OVERLAY_SHADOW, OVERLAY_TEXT, OVERLAY_ICON,
       OVERLAY_GRADIENT, OVERLAY_CLIP, OVERLAY_UNCLIP };
typedef struct {
  uint8_t kind, face, corners, icon, axis; int size; mu_Rect rect; mu_Color color, secondary;
  float radius; int width; char text[128];
} OverlayCommand;
#define RE_UI_OVERLAY_COMMANDS 512

static struct { ReDraw *draw; double seconds; bool animating, recording; int count;
                mu_Rect scissor, applied; bool scissor_on, applied_on;
                OverlayCommand commands[RE_UI_OVERLAY_COMMANDS]; Transition slots[RE_UI_TRANSITIONS]; } ui;

static OverlayCommand *record(uint8_t kind, mu_Rect rect, mu_Color color) {
  if (ui.count >= RE_UI_OVERLAY_COMMANDS) return NULL;
  OverlayCommand *c = &ui.commands[ui.count++];
  memset(c, 0, sizeof(*c)); c->kind = kind; c->rect = rect; c->color = color;
  return c;
}
void re_ui_overlay_begin(void) { ui.recording = true; ui.count = 0; }
void re_ui_overlay_end(void) { ui.recording = false; }
bool re_ui_overlay_pending(void) { return ui.count > 0; }
void re_ui_overlay_flush(ReDraw *draw) {
  for (int i = 0; i < ui.count; i++) {
    const OverlayCommand *c = &ui.commands[i];
    switch (c->kind) {
      case OVERLAY_RECT: re_draw_rect(draw, c->rect, c->color); break;
      case OVERLAY_RRECT: re_draw_rrect(draw, c->rect, c->color, c->radius, c->corners); break;
      case OVERLAY_FRAME: re_draw_frame(draw, c->rect, c->color, c->secondary, c->radius); break;
      case OVERLAY_RING: re_draw_ring(draw, c->rect, c->color, c->radius, c->width); break;
      case OVERLAY_SHADOW: re_draw_shadow(draw, c->rect, c->color, c->radius, c->width); break;
      case OVERLAY_TEXT: re_draw_text_face(draw, c->face, c->size, c->text, -1, c->rect.x, c->rect.y, c->color); break;
      case OVERLAY_ICON: re_draw_icon_sized(draw, c->icon, c->size, c->rect, c->color); break;
      case OVERLAY_GRADIENT: re_draw_gradient(draw, c->rect, c->color, c->secondary, c->radius, c->corners, c->axis); break;
      case OVERLAY_CLIP: re_draw_clip(draw, &c->rect); break;
      case OVERLAY_UNCLIP: re_draw_clip(draw, NULL); break;
      default: break;
    }
  }
  if (ui.count) re_draw_clip(draw, NULL);
  ui.count = 0;
}

/* Owned controls draw straight into the list at UI-build time, so microui's clip never reaches them.
 * Every control takes the container's clip before it draws; the primitives below emit it lazily, and
 * a control whose content overflows narrows it further through ui_clip — see sidecar: control-scissor */
static mu_Rect intersect(mu_Rect a, mu_Rect b) {
  int x = a.x > b.x ? a.x : b.x, y = a.y > b.y ? a.y : b.y;
  int right = a.x + a.w < b.x + b.w ? a.x + a.w : b.x + b.w;
  int bottom = a.y + a.h < b.y + b.h ? a.y + a.h : b.y + b.h;
  return mu_rect(x, y, right > x ? right - x : 0, bottom > y ? bottom - y : 0);
}
static bool same_rect(mu_Rect a, mu_Rect b) { return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h; }
static void emit_clip(const mu_Rect *rect);
static void ui_scissor(mu_Context *ctx) { ui.scissor = mu_get_clip_rect(ctx); ui.scissor_on = true; }
static void apply_scissor(void) {
  if (!ui.scissor_on) return;
  if (ui.applied_on && same_rect(ui.applied, ui.scissor)) return;
  emit_clip(&ui.scissor); ui.applied = ui.scissor; ui.applied_on = true;
}

/* Every control draws through these, so recording is a property of the frame rather than of a call site. */
static void ui_rect(mu_Rect rect, mu_Color color) {
  apply_scissor();
  if (ui.recording) { record(OVERLAY_RECT, rect, color); return; }
  re_draw_rect(ui.draw, rect, color);
}
static void ui_rrect(mu_Rect rect, mu_Color color, float radius, uint8_t corners) {
  apply_scissor();
  if (ui.recording) { OverlayCommand *c = record(OVERLAY_RRECT, rect, color); if (c) { c->radius = radius; c->corners = corners; } return; }
  re_draw_rrect(ui.draw, rect, color, radius, corners);
}
static void ui_frame(mu_Rect rect, mu_Color border, mu_Color highlight, float radius) {
  apply_scissor();
  if (ui.recording) { OverlayCommand *c = record(OVERLAY_FRAME, rect, border); if (c) { c->secondary = highlight; c->radius = radius; } return; }
  re_draw_frame(ui.draw, rect, border, highlight, radius);
}
static void ui_ring(mu_Rect rect, mu_Color color, float radius, int width) {
  apply_scissor();
  if (ui.recording) { OverlayCommand *c = record(OVERLAY_RING, rect, color); if (c) { c->radius = radius; c->width = width; } return; }
  re_draw_ring(ui.draw, rect, color, radius, width);
}
static void ui_shadow(mu_Rect rect, mu_Color color, float radius, int width) {
  apply_scissor();
  if (ui.recording) { OverlayCommand *c = record(OVERLAY_SHADOW, rect, color); if (c) { c->radius = radius; c->width = width; } return; }
  re_draw_shadow(ui.draw, rect, color, radius, width);
}
static void ui_text(uint8_t face, int size, const char *text, int x, int y, mu_Color color) {
  apply_scissor();
  if (ui.recording) {
    OverlayCommand *c = record(OVERLAY_TEXT, mu_rect(x, y, 0, 0), color);
    if (c) { c->face = face; c->size = size; snprintf(c->text, sizeof(c->text), "%s", text); }
    return;
  }
  re_draw_text_face(ui.draw, face, size, text, -1, x, y, color);
}
static void ui_gradient(mu_Rect rect, mu_Color from, mu_Color to, float radius, uint8_t corners, uint8_t axis) {
  apply_scissor();
  if (ui.recording) {
    OverlayCommand *c = record(OVERLAY_GRADIENT, rect, from);
    if (c) { c->secondary = to; c->radius = radius; c->corners = corners; c->axis = axis; }
    return;
  }
  re_draw_gradient(ui.draw, rect, from, to, radius, corners, axis);
}
/* A mark inside a small box is drawn at the box's size, not the text size: the check in a 14px
 * checkbox was rendered at 16px, which cropped it to a diagonal stroke that read as a slash. */
static void ui_icon_sized(uint8_t icon, int size, mu_Rect rect, mu_Color color) {
  apply_scissor();
  if (ui.recording) { OverlayCommand *c = record(OVERLAY_ICON, rect, color); if (c) { c->icon = icon; c->size = size; } return; }
  re_draw_icon_sized(ui.draw, icon, size, rect, color);
}
static void ui_icon(uint8_t icon, mu_Rect rect, mu_Color color) { ui_icon_sized(icon, RE_THEME_FONT_SIZE, rect, color); }
static void emit_clip(const mu_Rect *rect) {
  if (ui.recording) { if (rect) record(OVERLAY_CLIP, *rect, mu_color(0, 0, 0, 0)); else record(OVERLAY_UNCLIP, mu_rect(0, 0, 0, 0), mu_color(0, 0, 0, 0)); return; }
  re_draw_clip(ui.draw, rect);
}
/* A control narrowing its own clip still sits inside the container's. Passing NULL returns to the
 * container's clip rather than to the whole window. */
static void ui_clip(const mu_Rect *rect) {
  if (!rect) {
    if (ui.scissor_on) { emit_clip(&ui.scissor); ui.applied = ui.scissor; ui.applied_on = true; }
    else { emit_clip(NULL); ui.applied_on = false; }
    return;
  }
  mu_Rect box = ui.scissor_on ? intersect(*rect, ui.scissor) : *rect;
  emit_clip(&box); ui.applied = box; ui.applied_on = true;
}

void re_ui_begin(ReDraw *draw, double seconds) {
  ui.draw = draw; ui.seconds = seconds; ui.animating = false;
  ui.scissor_on = false; ui.applied_on = false;
}
bool re_ui_animating(void) { return ui.animating; }

static float progress(mu_Id id, bool target) {
  Transition *slot = NULL, *oldest = &ui.slots[0];
  for (int i = 0; i < RE_UI_TRANSITIONS; i++) {
    if (ui.slots[i].id == id) { slot = &ui.slots[i]; break; }
    if (ui.slots[i].seen < oldest->seen) oldest = &ui.slots[i];
  }
  if (!slot) { slot = oldest; slot->id = id; slot->value = target ? 1.0f : 0.0f; }
  float goal = target ? 1.0f : 0.0f;
  double elapsed = ui.seconds - slot->seen;
  slot->seen = ui.seconds;
  if (elapsed > 0 && elapsed < 1.0) {
    float step = (float)(elapsed / RE_UI_TRANSITION_SECONDS);
    if (slot->value < goal) slot->value = slot->value + step < goal ? slot->value + step : goal;
    else if (slot->value > goal) slot->value = slot->value - step > goal ? slot->value - step : goal;
  } else {
    slot->value = goal;
  }
  if (slot->value != goal) ui.animating = true;
  return slot->value;
}

/* Clipping breaks the adapters' batches and sets a scissor, so text that fits is drawn unclipped
 * — see sidecar: clip-cost */
static void text_clipped(uint8_t face, int size, const char *text, int x, int y, mu_Color color, mu_Rect box) {
  int width = re_draw_text_width(ui.draw, face, size, text, -1);
  if (x + width <= box.x + box.w) { ui_text(face, size, text, x, y, color); return; }
  ui_clip(&box);
  ui_text(face, size, text, x, y, color);
  ui_clip(NULL);
}

static mu_Color mix(mu_Color a, mu_Color b, float t) {
  mu_Color out;
  out.r = (unsigned char)(a.r + (b.r - a.r) * t); out.g = (unsigned char)(a.g + (b.g - a.g) * t);
  out.b = (unsigned char)(a.b + (b.b - a.b) * t); out.a = (unsigned char)(a.a + (b.a - a.a) * t);
  return out;
}
static uint8_t corners_for(int opt) {
  if (opt & RE_UI_GROUP_MIDDLE) return 0;
  if (opt & RE_UI_GROUP_FIRST) return RE_CORNER_TOP_LEFT | RE_CORNER_BOTTOM_LEFT;
  if (opt & RE_UI_GROUP_LAST) return RE_CORNER_TOP_RIGHT | RE_CORNER_BOTTOM_RIGHT;
  return RE_CORNERS_ALL;
}
static int label_size(int opt) {
  return opt & RE_UI_SMALL ? RE_METRIC_DESIGN_SIZE_SM : opt & RE_UI_LARGE ? RE_METRIC_DESIGN_SIZE_LG : RE_METRIC_DESIGN_SIZE;
}
static uint8_t label_face(int opt) { return opt & RE_UI_STRONG ? RE_FACE_UI_SEMIBOLD : RE_FACE_UI_MEDIUM; }
static mu_Color label_color(int opt, float on) {
  if (opt & RE_UI_DISABLED) return RE_COLOR_TEXT_FAINT;
  if (opt & RE_UI_PRIMARY) return RE_COLOR_TEXT_ON_ACCENT;
  return mix(opt & RE_UI_MUTED ? RE_COLOR_TEXT_MUTED : RE_COLOR_TEXT, RE_COLOR_TEXT_STRONG, on);
}

void re_ui_focus_ring(ReDraw *draw, mu_Rect rect, float radius) {
  re_draw_ring(draw, rect, RE_COLOR_FOCUS, radius + RE_METRIC_DESIGN_FOCUS_WIDTH, RE_METRIC_DESIGN_FOCUS_WIDTH);
}
/* A panel starts a surface: it is drawn outside any container, so it also ends the previous view's
 * clip. Without that, the next pane's ground would inherit the last pane's scissor. */
void re_ui_panel(ReDraw *draw, mu_Rect rect, mu_Color fill) {
  ui.scissor_on = false; ui.applied_on = false;
  re_draw_clip(draw, NULL);
  re_draw_rect(draw, rect, fill);
}
/* A view that draws directly rather than through controls takes its container's clip with this. */
void re_ui_clip(mu_Context *ctx) { ui_scissor(ctx); apply_scissor(); }
void re_ui_end(ReDraw *draw) { ui.scissor_on = false; ui.applied_on = false; re_draw_clip(draw, NULL); }

void re_ui_popover(mu_Rect rect) {
  /* The ground and its shadow reach past the container, so the surface starts with no scissor; the
   * rows inside it take the container's clip as every other control does. */
  ui.scissor_on = false; ui.applied_on = false; emit_clip(NULL);
  ui_shadow(rect, RE_COLOR_CANVAS, RE_METRIC_DESIGN_RADIUS_LG, RE_METRIC_DESIGN_PAD);
  ui_rrect(rect, RE_COLOR_SURFACE_RAISED, RE_METRIC_DESIGN_RADIUS_LG, RE_CORNERS_ALL);
  ui_frame(rect, RE_COLOR_BORDER, RE_COLOR_HIGHLIGHT, RE_METRIC_DESIGN_RADIUS_LG);
}
void re_ui_heading(mu_Context *ctx, const char *text) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  int size = RE_METRIC_DESIGN_SIZE_SM;
  ui_text(RE_FACE_UI_SEMIBOLD, size, text, rect.x, rect.y + (rect.h - size) / 2 - 1, RE_COLOR_TEXT_MUTED);
  ui_rect(mu_rect(rect.x, rect.y + rect.h - 1, rect.w, 1), RE_COLOR_BORDER_SOFT);
}

/* Fill, frame and focus ring shared by every boxed control. */
static void chrome(mu_Rect rect, int opt, float hover, bool focused, bool field) {
  if (opt & RE_UI_TRANSPARENT) { if (focused) ui_ring(rect, RE_COLOR_FOCUS, RE_METRIC_DESIGN_RADIUS + RE_METRIC_DESIGN_FOCUS_WIDTH, RE_METRIC_DESIGN_FOCUS_WIDTH); return; }
  uint8_t corners = corners_for(opt);
  float radius = RE_METRIC_DESIGN_RADIUS;
  mu_Color rest = field ? RE_COLOR_FIELD : RE_COLOR_CONTROL;
  mu_Color over = field ? RE_COLOR_FIELD_HOVER : RE_COLOR_CONTROL_HOVER;
  if (opt & RE_UI_PRIMARY) { rest = RE_COLOR_ACCENT; over = RE_COLOR_ACCENT_HOVER; }
  else if (opt & RE_UI_ON) { rest = RE_COLOR_CONTROL_ACTIVE; over = RE_COLOR_CONTROL_HOVER; }
  else if (opt & RE_UI_GHOST) { rest = mu_color(rest.r, rest.g, rest.b, 0); }
  if (opt & RE_UI_DISABLED) over = rest;
  ui_rrect(rect, mix(rest, over, hover), radius, corners);
  bool grouped = (opt & (RE_UI_GROUP_FIRST | RE_UI_GROUP_MIDDLE | RE_UI_GROUP_LAST)) != 0;
  if (grouped) {
    /* The group carries one border; members only rule the seam between them. */
    if (!(opt & RE_UI_GROUP_FIRST)) ui_rect(mu_rect(rect.x, rect.y, 1, rect.h), RE_COLOR_BORDER);
    if (opt & RE_UI_ON) {
      ui_rect(mu_rect(rect.x, rect.y + rect.h - RE_METRIC_DESIGN_GROUP_MARKER, rect.w, RE_METRIC_DESIGN_GROUP_MARKER), RE_COLOR_ACCENT);
    }
  } else if (!(opt & RE_UI_GHOST) || hover > 0) {
    ui_frame(rect, RE_COLOR_BORDER, RE_COLOR_HIGHLIGHT, radius);
  }
  if (focused) ui_ring(rect, RE_COLOR_FOCUS, radius + RE_METRIC_DESIGN_FOCUS_WIDTH, RE_METRIC_DESIGN_FOCUS_WIDTH);
}

/* Icon, label and trailing caret inside a control's box, at the card's paddings and gaps. */
static void contents(mu_Rect rect, const char *label, int icon, int opt, mu_Color color) {
  if (opt & RE_UI_TRANSPARENT) return;
  int size = label_size(opt), pad = opt & RE_UI_FIELD_PAD ? RE_METRIC_DESIGN_FIELD_PAD : RE_METRIC_DESIGN_CONTROL_PAD;
  int icon_box = icon != RE_ICON_UNKNOWN ? size + RE_METRIC_DESIGN_ICON_GAP : 0;
  int caret_box = opt & RE_UI_CARET ? size + RE_METRIC_DESIGN_ICON_GAP : 0;
  int width = label ? re_draw_text_width(ui.draw, label_face(opt), size, label, -1) : 0;
  int text_y = rect.y + (rect.h - size) / 2 - 1, x;
  if (opt & RE_UI_ICON_ONLY) {
    ui_icon((uint8_t)icon, rect, color);
    return;
  }
  if (opt & RE_UI_ALIGN_LEFT) x = rect.x + pad;
  else x = rect.x + (rect.w - width - icon_box - caret_box) / 2;
  if (x < rect.x + pad) x = rect.x + pad;
  if (icon_box) {
    ui_icon((uint8_t)icon, mu_rect(x, rect.y, size, rect.h), color);
    x += icon_box;
  }
  if (label) ui_text(label_face(opt), size, label, x, text_y, color);
  if (caret_box) {
    ui_icon(RE_ICON_EXPANDED, mu_rect(rect.x + rect.w - pad - size, rect.y, size, rect.h),
                 opt & RE_UI_DISABLED ? RE_COLOR_TEXT_FAINT : RE_COLOR_TEXT_MUTED);
  }
}

static int control(mu_Context *ctx, const char *label, int icon, int opt, bool field) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  mu_Id id = mu_get_id(ctx, label ? label : (const char *)&icon, label ? (int)strlen(label) : (int)sizeof(icon));
  int res = 0;
  if (!(opt & RE_UI_DISABLED)) {
    mu_update_control(ctx, id, rect, 0);
    if (ctx->mouse_pressed == MU_MOUSE_LEFT && ctx->focus == id) res |= MU_RES_SUBMIT;
  }
  bool hovered = !(opt & RE_UI_DISABLED) && ctx->hover == id;
  float hover = progress(id, hovered || (opt & RE_UI_ON) != 0);
  chrome(rect, opt, hover, !(opt & RE_UI_DISABLED) && ctx->focus == id, field);
  contents(rect, label, icon, opt, label_color(opt, hover));
  return res;
}

int re_ui_button_ex(mu_Context *ctx, const char *label, int icon, int opt) { return control(ctx, label, icon, opt, false); }
int re_ui_select_ex(mu_Context *ctx, const char *label, int icon, int opt) { return control(ctx, label, icon, opt | RE_UI_CARET, true); }

int re_ui_textbox_ex(mu_Context *ctx, char *buffer, int size, int icon, const char *placeholder, int opt) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  mu_Id id = mu_get_id(ctx, &buffer, sizeof(buffer));
  int res = 0;
  mu_update_control(ctx, id, rect, MU_OPT_HOLDFOCUS);
  if (ctx->focus == id) { /* microui's own textbox draws itself, so the editing rules are restated here */
    int length = (int)strlen(buffer), room = size - length - 1, typed = (int)strlen(ctx->input_text);
    if (typed > 0 && room > 0) {
      if (typed > room) typed = room;
      memcpy(buffer + length, ctx->input_text, (size_t)typed); length += typed; buffer[length] = 0; res |= MU_RES_CHANGE;
    }
    if ((ctx->key_pressed & MU_KEY_BACKSPACE) && length > 0) {
      while (length > 0 && (buffer[--length] & 0xc0) == 0x80) {}
      buffer[length] = 0; res |= MU_RES_CHANGE;
    }
    if (ctx->key_pressed & MU_KEY_RETURN) { mu_set_focus(ctx, 0); res |= MU_RES_SUBMIT; }
  }
  float hover = progress(id, ctx->hover == id);
  bool focused = ctx->focus == id;
  chrome(rect, (opt & ~(RE_UI_PRIMARY | RE_UI_ON)) | RE_UI_FIELD_PAD, hover, focused, true);
  int text_size = label_size(opt), pad = RE_METRIC_DESIGN_FIELD_PAD;
  int x = rect.x + pad, text_y = rect.y + (rect.h - text_size) / 2 - 1;
  if (icon != RE_ICON_UNKNOWN) {
    ui_icon((uint8_t)icon, mu_rect(x, rect.y, text_size, rect.h), RE_COLOR_TEXT_FAINT);
    x += text_size + RE_METRIC_DESIGN_ICON_GAP;
  }
  mu_Rect box = mu_rect(rect.x, rect.y, rect.w - pad, rect.h);
  if (*buffer) {
    int width = re_draw_text_width(ui.draw, RE_FACE_UI, text_size, buffer, -1);
    text_clipped(RE_FACE_UI, text_size, buffer, x, text_y, RE_COLOR_TEXT, box);
    if (focused && x + width + 1 + RE_METRIC_EDITOR_CARET_WIDTH <= box.x + box.w) {
      ui_rect(mu_rect(x + width + 1, text_y, RE_METRIC_EDITOR_CARET_WIDTH, text_size), RE_COLOR_CARET);
    }
  } else if (placeholder) {
    /* A suggestion is not content: it sits below the faint role's own weight so it never reads as typed text. */
    mu_Color ghost = RE_COLOR_TEXT_FAINT;
    ghost.a = (unsigned char)((int)ghost.a * RE_METRIC_DESIGN_PLACEHOLDER_ALPHA / 100);
    text_clipped(RE_FACE_UI, text_size, placeholder, x, text_y, ghost, box);
    if (focused) ui_rect(mu_rect(x, text_y, RE_METRIC_EDITOR_CARET_WIDTH, text_size), RE_COLOR_CARET);
  }
  return res;
}

int re_ui_checkbox_ex(mu_Context *ctx, const char *label, int *state, int opt) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  mu_Id id = mu_get_id(ctx, &state, sizeof(state));
  int res = 0, size = label_size(opt), side = RE_METRIC_DESIGN_CHECKBOX_BOX;
  mu_Rect box = mu_rect(rect.x, rect.y + (rect.h - side) / 2, side, side);
  mu_update_control(ctx, id, rect, 0);
  if (ctx->mouse_pressed == MU_MOUSE_LEFT && ctx->focus == id) { res |= MU_RES_CHANGE; *state = !*state; }
  float hover = progress(id, ctx->hover == id);
  mu_Color fill = *state ? mix(RE_COLOR_ACCENT, RE_COLOR_ACCENT_HOVER, hover) : mix(RE_COLOR_FIELD, RE_COLOR_FIELD_HOVER, hover);
  ui_rrect(box, fill, RE_METRIC_DESIGN_RADIUS, RE_CORNERS_ALL);
  ui_frame(box, RE_COLOR_BORDER, RE_COLOR_HIGHLIGHT, RE_METRIC_DESIGN_RADIUS);
  if (*state) ui_icon_sized(RE_ICON_CHECK, side - RE_METRIC_DESIGN_GAP, box, RE_COLOR_TEXT_ON_ACCENT);
  if (ctx->focus == id) ui_ring(box, RE_COLOR_FOCUS, RE_METRIC_DESIGN_RADIUS + RE_METRIC_DESIGN_FOCUS_WIDTH, RE_METRIC_DESIGN_FOCUS_WIDTH);
  if (label) {
    ui_text(label_face(opt), size, label, box.x + side + RE_METRIC_DESIGN_ICON_GAP,
                      rect.y + (rect.h - size) / 2 - 1, label_color(opt, hover));
  }
  return res;
}

int re_ui_slider_ex(mu_Context *ctx, float *value, float low, float high, int opt) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  mu_Id id = mu_get_id(ctx, &value, sizeof(value));
  int res = 0, knob = RE_METRIC_DESIGN_ROW / 2, track_h = RE_METRIC_DESIGN_GAP;
  mu_update_control(ctx, id, rect, 0);
  if (ctx->focus == id && (ctx->mouse_down | ctx->mouse_pressed) == MU_MOUSE_LEFT && rect.w > knob) {
    float span = high - low, at = (float)(ctx->mouse_pos.x - rect.x - knob / 2) / (float)(rect.w - knob);
    float next = low + (at < 0 ? 0 : at > 1 ? 1 : at) * span;
    if (next != *value) { *value = next; res |= MU_RES_CHANGE; }
  }
  float hover = progress(id, ctx->hover == id || ctx->focus == id);
  float fraction = high > low ? (*value - low) / (high - low) : 0;
  fraction = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  mu_Rect track = mu_rect(rect.x, rect.y + (rect.h - track_h) / 2, rect.w, track_h);
  ui_rrect(track, RE_COLOR_FIELD, (float)track_h / 2, RE_CORNERS_ALL);
  if (!(opt & RE_UI_GHOST)) {
    mu_Rect filled = mu_rect(track.x, track.y, (int)(fraction * (float)track.w), track.h);
    ui_rrect(filled, RE_COLOR_ACCENT, (float)track_h / 2, RE_CORNERS_ALL);
  }
  mu_Rect thumb = mu_rect(rect.x + (int)(fraction * (float)(rect.w - knob)), rect.y + (rect.h - knob) / 2, knob, knob);
  ui_shadow(thumb, RE_COLOR_CANVAS, (float)knob / 2, 2);
  ui_rrect(thumb, mix(RE_COLOR_TEXT, RE_COLOR_TEXT_STRONG, hover), (float)knob / 2, RE_CORNERS_ALL);
  if (ctx->focus == id) ui_ring(thumb, RE_COLOR_FOCUS, (float)knob / 2 + RE_METRIC_DESIGN_FOCUS_WIDTH, RE_METRIC_DESIGN_FOCUS_WIDTH);
  return res;
}

/* A menu row from the menus card: icon, label, and a right-aligned mono hint. Hover fills with the
 * accent the way the card shows it, and a marked row keeps its dot — see sidecar: menu-item */
int re_ui_menu_item(mu_Context *ctx, const char *label, int icon, const char *hint, bool marked) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  mu_Id id = mu_get_id(ctx, label, (int)strlen(label));
  mu_update_control(ctx, id, rect, 0);
  int res = (ctx->mouse_pressed == MU_MOUSE_LEFT && ctx->focus == id) ? MU_RES_SUBMIT : 0;
  float hover = progress(id, ctx->hover == id);
  int size = RE_METRIC_DESIGN_SIZE, gap = RE_METRIC_DESIGN_GAP, icon_width = RE_METRIC_DESIGN_ICON_GAP * 2;
  if (hover > 0) {
    mu_Color fill = RE_COLOR_ACCENT; fill.a = (unsigned char)((float)fill.a * hover);
    ui_rrect(rect, fill, RE_METRIC_DESIGN_RADIUS, RE_CORNERS_ALL);
  }
  mu_Color ink = mix(RE_COLOR_TEXT, RE_COLOR_TEXT_ON_ACCENT, hover);
  if (marked) ui_icon_sized(RE_ICON_CHECK, icon_width, mu_rect(rect.x + gap, rect.y, icon_width, rect.h), hover > 0.5f ? ink : RE_COLOR_ACCENT);
  else if (icon >= 0) ui_icon((uint8_t)icon, mu_rect(rect.x + gap, rect.y, icon_width, rect.h), hover > 0.5f ? ink : RE_COLOR_TEXT_MUTED);
  ui_text(RE_FACE_UI, size, label, rect.x + gap + icon_width + gap, rect.y + (rect.h - size) / 2 - 1, ink);
  if (hint && *hint) {
    int width = re_draw_text_width(ui.draw, RE_FACE_MONO, RE_METRIC_DESIGN_SIZE_SM, hint, -1);
    ui_text(RE_FACE_MONO, RE_METRIC_DESIGN_SIZE_SM, hint, rect.x + rect.w - gap - width,
            rect.y + (rect.h - RE_METRIC_DESIGN_SIZE_SM) / 2 - 1, hover > 0.5f ? ink : RE_COLOR_TEXT_FAINT);
  }
  return res;
}
void re_ui_menu_separator(mu_Context *ctx) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  ui_rect(mu_rect(rect.x, rect.y + rect.h / 2, rect.w, 1), RE_COLOR_BORDER_SOFT);
}

/* The hue slider is the one place a gradient appears (spec 080). The track is a ring of ramps between
 * neighbouring hues, each drawn with the draw-list gradient primitive, so the colour a person picks is
 * literally the accent they will get — see sidecar: hue-track */
#define RE_UI_HUE_SEGMENTS 12
int re_ui_hue_slider(mu_Context *ctx, float *hue) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  mu_Id id = mu_get_id(ctx, &hue, sizeof(hue));
  int res = 0, knob = RE_METRIC_DESIGN_ROW / 2, track_h = RE_METRIC_DESIGN_GAP + 2;
  mu_update_control(ctx, id, rect, 0);
  if (ctx->focus == id && (ctx->mouse_down | ctx->mouse_pressed) == MU_MOUSE_LEFT && rect.w > knob) {
    float at = (float)(ctx->mouse_pos.x - rect.x - knob / 2) / (float)(rect.w - knob);
    float next = (float)((int)((at < 0 ? 0 : at > 1 ? 1 : at) * 360.0f + 0.5f) % 360);
    if (next != *hue) { *hue = next; res |= MU_RES_CHANGE; }
  }
  float hover = progress(id, ctx->hover == id || ctx->focus == id);
  float fraction = *hue / 360.0f;
  fraction = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  mu_Rect track = mu_rect(rect.x, rect.y + (rect.h - track_h) / 2, rect.w, track_h);
  float radius = (float)track_h / 2;
  int left = track.x;
  for (int i = 0; i < RE_UI_HUE_SEGMENTS; i++) {
    int right = track.x + (int)((float)track.w * (float)(i + 1) / (float)RE_UI_HUE_SEGMENTS + 0.5f);
    uint8_t corners = (uint8_t)((i == 0 ? RE_CORNER_TOP_LEFT | RE_CORNER_BOTTOM_LEFT : 0)
                              | (i == RE_UI_HUE_SEGMENTS - 1 ? RE_CORNER_TOP_RIGHT | RE_CORNER_BOTTOM_RIGHT : 0));
    mu_Color from = re_theme_swatch(360.0f * (float)i / (float)RE_UI_HUE_SEGMENTS);
    mu_Color to = re_theme_swatch(360.0f * (float)(i + 1) / (float)RE_UI_HUE_SEGMENTS);
    ui_gradient(mu_rect(left, track.y, right - left, track.h), from, to, radius, corners, RE_GRADIENT_HORIZONTAL);
    left = right;
  }
  mu_Rect thumb = mu_rect(rect.x + (int)(fraction * (float)(rect.w - knob)), rect.y + (rect.h - knob) / 2, knob, knob);
  ui_shadow(thumb, RE_COLOR_CANVAS, (float)knob / 2, 2);
  ui_rrect(thumb, re_theme_swatch(*hue), (float)knob / 2, RE_CORNERS_ALL);
  ui_ring(thumb, mix(RE_COLOR_BORDER, RE_COLOR_TEXT_STRONG, hover), (float)knob / 2, 2);
  if (ctx->focus == id) ui_ring(thumb, RE_COLOR_FOCUS, (float)knob / 2 + RE_METRIC_DESIGN_FOCUS_WIDTH, RE_METRIC_DESIGN_FOCUS_WIDTH);
  return res;
}

int re_ui_row_ex(mu_Context *ctx, const char *name, int icon, const char *meta, int depth, int opt) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  mu_Id id = mu_get_id(ctx, name, (int)strlen(name));
  int res = 0, size = label_size(opt), pad = RE_METRIC_DESIGN_ICON_GAP;
  if (!(opt & RE_UI_DISABLED)) {
    mu_update_control(ctx, id, rect, 0);
    if (ctx->mouse_pressed == MU_MOUSE_LEFT && ctx->focus == id) res |= MU_RES_SUBMIT;
  }
  float hover = progress(id, ctx->hover == id);
  if (opt & RE_UI_ON) ui_rrect(rect, RE_COLOR_TREE_SELECTED_BG, RE_METRIC_DESIGN_RADIUS, RE_CORNERS_ALL);
  else if (hover > 0) {
    mu_Color highlight = RE_COLOR_HIGHLIGHT;
    highlight.a = (unsigned char)((float)highlight.a * hover);
    ui_rrect(rect, highlight, RE_METRIC_DESIGN_RADIUS, RE_CORNERS_ALL);
  }
  int x = rect.x + pad + depth * RE_METRIC_DESIGN_TREE_INDENT, text_y = rect.y + (rect.h - size) / 2 - 1;
  mu_Color color = opt & RE_UI_ON ? RE_COLOR_TREE_SELECTED_FG : opt & RE_UI_MUTED ? RE_COLOR_TEXT_MUTED : RE_COLOR_TREE_FG;
  if (icon != RE_ICON_UNKNOWN) {
    ui_icon((uint8_t)icon, mu_rect(x, rect.y, size, rect.h), opt & RE_UI_ON ? color : RE_COLOR_TREE_ICON);
    x += size + RE_METRIC_DESIGN_ICON_GAP;
  }
  int meta_width = meta && *meta ? re_draw_text_width(ui.draw, RE_FACE_UI, RE_METRIC_DESIGN_SIZE_SM, meta, -1) : 0;
  if (meta_width) {
    ui_text(RE_FACE_UI, RE_METRIC_DESIGN_SIZE_SM, meta, rect.x + rect.w - pad - meta_width,
                      rect.y + (rect.h - RE_METRIC_DESIGN_SIZE_SM) / 2 - 1, RE_COLOR_TEXT_FAINT);
    meta_width += RE_METRIC_DESIGN_ICON_GAP;
  }
  text_clipped(label_face(opt), size, name, x, text_y, color,
               mu_rect(x, rect.y, re_max(0, rect.x + rect.w - pad - meta_width - x), rect.h));
  if (ctx->focus == id) ui_ring(rect, RE_COLOR_FOCUS, RE_METRIC_DESIGN_RADIUS + RE_METRIC_DESIGN_FOCUS_WIDTH, RE_METRIC_DESIGN_FOCUS_WIDTH);
  return res;
}

void re_ui_pill(mu_Context *ctx, const char *label, int kind) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  int size = RE_METRIC_DESIGN_SIZE_SM, dot = RE_METRIC_DESIGN_GAP + 1, pad = RE_METRIC_DESIGN_ICON_GAP;
  int width = re_draw_text_width(ui.draw, RE_FACE_UI_MEDIUM, size, label, -1) + dot + pad * 3;
  mu_Rect box = mu_rect(rect.x, rect.y + (rect.h - RE_METRIC_DESIGN_ROW) / 2, re_min_int(width, rect.w), RE_METRIC_DESIGN_ROW);
  mu_Color hue = kind == RE_UI_PILL_OK ? RE_COLOR_OK : kind == RE_UI_PILL_WARN ? RE_COLOR_WARN
               : kind == RE_UI_PILL_ERR ? RE_COLOR_ERR : kind == RE_UI_PILL_INFO ? RE_COLOR_INFO : RE_COLOR_TEXT_FAINT;
  ui_rrect(box, RE_COLOR_FIELD, RE_METRIC_DESIGN_RADIUS, RE_CORNERS_ALL);
  ui_rrect(mu_rect(box.x + pad, box.y + (box.h - dot) / 2, dot, dot), hue, (float)dot / 2, RE_CORNERS_ALL);
  text_clipped(RE_FACE_UI_MEDIUM, size, label, box.x + pad + dot + pad, box.y + (box.h - size) / 2 - 1, RE_COLOR_TEXT_MUTED,
               mu_rect(box.x, box.y, re_max_int(0, box.w - pad), box.h));
}

void re_ui_label_ex(mu_Context *ctx, const char *label, int opt) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  int size = label_size(opt);
  ui_text(opt & RE_UI_STRONG ? RE_FACE_UI_SEMIBOLD : RE_FACE_UI, size, label,
          rect.x, rect.y + (rect.h - size) / 2 - 1, label_color(opt, 0));
}

void re_ui_separator(mu_Context *ctx) {
  ui_scissor(ctx);
  mu_Rect rect = mu_layout_next(ctx);
  int height = RE_METRIC_DESIGN_SEPARATOR_HEIGHT;
  ui_rect(mu_rect(rect.x + rect.w / 2, rect.y + (rect.h - height) / 2, 1, height), RE_COLOR_BORDER_SOFT);
}

void re_ui_tab(ReDraw *draw, mu_Rect rect, const char *label, int icon, bool active, bool dirty, int reserve) {
  int size = RE_METRIC_DESIGN_SIZE, pad = RE_METRIC_DESIGN_GAP_LG;
  uint8_t corners = RE_CORNER_TOP_LEFT | RE_CORNER_TOP_RIGHT;
  if (active) {
    re_draw_rrect(draw, rect, RE_COLOR_TAB_ACTIVE_BG, RE_METRIC_DESIGN_RADIUS, corners);
    re_draw_rect(draw, mu_rect(rect.x, rect.y, rect.w, RE_METRIC_DESIGN_FOCUS_WIDTH), RE_COLOR_TAB_MARKER);
  }
  int x = rect.x + pad;
  mu_Color color = active ? RE_COLOR_TAB_ACTIVE_FG : RE_COLOR_TAB_FG;
  if (icon != RE_ICON_UNKNOWN) { re_draw_icon(draw, (uint8_t)icon, mu_rect(x, rect.y, size, rect.h), color); x += size + RE_METRIC_DESIGN_GAP; }
  if (dirty) {
    re_draw_icon(draw, RE_ICON_DIRTY, mu_rect(x, rect.y, size, rect.h), RE_COLOR_ACCENT);
    x += size;
  }
  /* The title stops before the close control rather than running under it. */
  text_clipped(active ? RE_FACE_UI_SEMIBOLD : RE_FACE_UI_MEDIUM, size, label, x, rect.y + (rect.h - size) / 2 - 1, color,
               mu_rect(rect.x, rect.y, re_max(0, rect.w - pad - reserve), rect.h));
}

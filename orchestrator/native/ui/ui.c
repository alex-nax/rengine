#include "ui/ui.h"
#include "theme.h"
#include <string.h>

/* Hover and focus move over RE_METRIC_DESIGN_TRANSITION_MS; the table is fixed and frame-stamped,
 * so a control that stops being drawn simply loses its slot — see sidecar: transition-clock */
#define RE_UI_TRANSITIONS 256
#define RE_UI_TRANSITION_SECONDS 0.09

typedef struct { mu_Id id; float value; double seen; } Transition;
static struct { ReDraw *draw; double seconds; bool animating; Transition slots[RE_UI_TRANSITIONS]; } ui;

void re_ui_begin(ReDraw *draw, double seconds) { ui.draw = draw; ui.seconds = seconds; ui.animating = false; }
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
void re_ui_panel(ReDraw *draw, mu_Rect rect, mu_Color fill) { re_draw_rect(draw, rect, fill); }

/* Fill, frame and focus ring shared by every boxed control. */
static void chrome(mu_Rect rect, int opt, float hover, bool focused, bool field) {
  if (opt & RE_UI_TRANSPARENT) { if (focused) re_ui_focus_ring(ui.draw, rect, RE_METRIC_DESIGN_RADIUS); return; }
  uint8_t corners = corners_for(opt);
  float radius = RE_METRIC_DESIGN_RADIUS;
  mu_Color rest = field ? RE_COLOR_FIELD : RE_COLOR_CONTROL;
  mu_Color over = field ? RE_COLOR_FIELD_HOVER : RE_COLOR_CONTROL_HOVER;
  if (opt & RE_UI_PRIMARY) { rest = RE_COLOR_ACCENT; over = RE_COLOR_ACCENT_HOVER; }
  else if (opt & RE_UI_ON) { rest = RE_COLOR_CONTROL_ACTIVE; over = RE_COLOR_CONTROL_HOVER; }
  else if (opt & RE_UI_GHOST) { rest = mu_color(rest.r, rest.g, rest.b, 0); }
  if (opt & RE_UI_DISABLED) over = rest;
  re_draw_rrect(ui.draw, rect, mix(rest, over, hover), radius, corners);
  bool grouped = (opt & (RE_UI_GROUP_FIRST | RE_UI_GROUP_MIDDLE | RE_UI_GROUP_LAST)) != 0;
  if (grouped) {
    /* The group carries one border; members only rule the seam between them. */
    if (!(opt & RE_UI_GROUP_FIRST)) re_draw_rect(ui.draw, mu_rect(rect.x, rect.y, 1, rect.h), RE_COLOR_BORDER);
    if (opt & RE_UI_ON) {
      re_draw_rect(ui.draw, mu_rect(rect.x, rect.y + rect.h - RE_METRIC_DESIGN_GROUP_MARKER, rect.w, RE_METRIC_DESIGN_GROUP_MARKER), RE_COLOR_ACCENT);
    }
  } else if (!(opt & RE_UI_GHOST) || hover > 0) {
    re_draw_frame(ui.draw, rect, RE_COLOR_BORDER, RE_COLOR_HIGHLIGHT, radius);
  }
  if (focused) re_ui_focus_ring(ui.draw, rect, radius);
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
    re_draw_icon(ui.draw, (uint8_t)icon, rect, color);
    return;
  }
  if (opt & RE_UI_ALIGN_LEFT) x = rect.x + pad;
  else x = rect.x + (rect.w - width - icon_box - caret_box) / 2;
  if (x < rect.x + pad) x = rect.x + pad;
  if (icon_box) {
    re_draw_icon(ui.draw, (uint8_t)icon, mu_rect(x, rect.y, size, rect.h), color);
    x += icon_box;
  }
  if (label) re_draw_text_face(ui.draw, label_face(opt), size, label, -1, x, text_y, color);
  if (caret_box) {
    re_draw_icon(ui.draw, RE_ICON_EXPANDED, mu_rect(rect.x + rect.w - pad - size, rect.y, size, rect.h),
                 opt & RE_UI_DISABLED ? RE_COLOR_TEXT_FAINT : RE_COLOR_TEXT_MUTED);
  }
}

static int control(mu_Context *ctx, const char *label, int icon, int opt, bool field) {
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
    re_draw_icon(ui.draw, (uint8_t)icon, mu_rect(x, rect.y, text_size, rect.h), RE_COLOR_TEXT_FAINT);
    x += text_size + RE_METRIC_DESIGN_ICON_GAP;
  }
  mu_Rect clip = mu_rect(rect.x, rect.y, rect.w - pad, rect.h);
  re_draw_clip(ui.draw, &clip);
  if (*buffer) {
    int width = re_draw_text_width(ui.draw, RE_FACE_UI, text_size, buffer, -1);
    re_draw_text_face(ui.draw, RE_FACE_UI, text_size, buffer, -1, x, text_y, RE_COLOR_TEXT);
    if (focused) re_draw_rect(ui.draw, mu_rect(x + width + 1, text_y, RE_METRIC_EDITOR_CARET_WIDTH, text_size), RE_COLOR_CARET);
  } else if (placeholder) {
    re_draw_text_face(ui.draw, RE_FACE_UI, text_size, placeholder, -1, x, text_y, RE_COLOR_TEXT_FAINT);
    if (focused) re_draw_rect(ui.draw, mu_rect(x, text_y, RE_METRIC_EDITOR_CARET_WIDTH, text_size), RE_COLOR_CARET);
  }
  re_draw_clip(ui.draw, NULL);
  return res;
}

int re_ui_checkbox_ex(mu_Context *ctx, const char *label, int *state, int opt) {
  mu_Rect rect = mu_layout_next(ctx);
  mu_Id id = mu_get_id(ctx, &state, sizeof(state));
  int res = 0, size = label_size(opt), side = RE_METRIC_DESIGN_CHECKBOX_BOX;
  mu_Rect box = mu_rect(rect.x, rect.y + (rect.h - side) / 2, side, side);
  mu_update_control(ctx, id, rect, 0);
  if (ctx->mouse_pressed == MU_MOUSE_LEFT && ctx->focus == id) { res |= MU_RES_CHANGE; *state = !*state; }
  float hover = progress(id, ctx->hover == id);
  mu_Color fill = *state ? mix(RE_COLOR_ACCENT, RE_COLOR_ACCENT_HOVER, hover) : mix(RE_COLOR_FIELD, RE_COLOR_FIELD_HOVER, hover);
  re_draw_rrect(ui.draw, box, fill, RE_METRIC_DESIGN_RADIUS, RE_CORNERS_ALL);
  re_draw_frame(ui.draw, box, RE_COLOR_BORDER, RE_COLOR_HIGHLIGHT, RE_METRIC_DESIGN_RADIUS);
  if (*state) re_draw_icon(ui.draw, RE_ICON_CHECK, box, RE_COLOR_TEXT_ON_ACCENT);
  if (ctx->focus == id) re_ui_focus_ring(ui.draw, box, RE_METRIC_DESIGN_RADIUS);
  if (label) {
    re_draw_text_face(ui.draw, label_face(opt), size, label, -1, box.x + side + RE_METRIC_DESIGN_ICON_GAP,
                      rect.y + (rect.h - size) / 2 - 1, label_color(opt, hover));
  }
  return res;
}

int re_ui_slider_ex(mu_Context *ctx, float *value, float low, float high, int opt) {
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
  re_draw_rrect(ui.draw, track, RE_COLOR_FIELD, (float)track_h / 2, RE_CORNERS_ALL);
  if (!(opt & RE_UI_GHOST)) {
    mu_Rect filled = mu_rect(track.x, track.y, (int)(fraction * (float)track.w), track.h);
    re_draw_rrect(ui.draw, filled, RE_COLOR_ACCENT, (float)track_h / 2, RE_CORNERS_ALL);
  }
  mu_Rect thumb = mu_rect(rect.x + (int)(fraction * (float)(rect.w - knob)), rect.y + (rect.h - knob) / 2, knob, knob);
  re_draw_shadow(ui.draw, thumb, RE_COLOR_CANVAS, (float)knob / 2, 2);
  re_draw_rrect(ui.draw, thumb, mix(RE_COLOR_TEXT, RE_COLOR_TEXT_STRONG, hover), (float)knob / 2, RE_CORNERS_ALL);
  if (ctx->focus == id) re_ui_focus_ring(ui.draw, thumb, (float)knob / 2);
  return res;
}

void re_ui_label_ex(mu_Context *ctx, const char *label, int opt) {
  mu_Rect rect = mu_layout_next(ctx);
  int size = label_size(opt);
  re_draw_text_face(ui.draw, opt & RE_UI_STRONG ? RE_FACE_UI_SEMIBOLD : RE_FACE_UI, size, label, -1,
                    rect.x, rect.y + (rect.h - size) / 2 - 1, label_color(opt, 0));
}

void re_ui_separator(mu_Context *ctx) {
  mu_Rect rect = mu_layout_next(ctx);
  int height = RE_METRIC_DESIGN_SEPARATOR_HEIGHT;
  re_draw_rect(ui.draw, mu_rect(rect.x + rect.w / 2, rect.y + (rect.h - height) / 2, 1, height), RE_COLOR_BORDER_SOFT);
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
  mu_Rect clip = mu_rect(rect.x, rect.y, re_max(0, rect.w - pad - reserve), rect.h);
  re_draw_clip(draw, &clip);
  re_draw_text_face(draw, active ? RE_FACE_UI_SEMIBOLD : RE_FACE_UI_MEDIUM, size, label, -1, x, rect.y + (rect.h - size) / 2 - 1, color);
  re_draw_clip(draw, NULL);
}

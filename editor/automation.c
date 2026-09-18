#include "automation.h"
#include "dock_icon.h"
#include "pluginview.h"
#include "scene.h"
#include "editor.h"
#include "render/syntax_theme.h"
static Uint32 automation_event;
static int read_commands(void *unused) {
  (void)unused; char line[16384];
  while (fgets(line, sizeof(line), stdin)) {
    cJSON *j = cJSON_Parse(line); if (!j) continue;
    SDL_Event event = {.type = automation_event}; event.user.data1 = j;
    if (SDL_PushEvent(&event) <= 0) cJSON_Delete(j);
  }
  return 0;
}
Uint32 re_automation_start(void) {
  automation_event = SDL_RegisterEvents(1);
  if (automation_event == (Uint32)-1) return 0;
  SDL_Thread *thread = SDL_CreateThread(read_commands, "test-input", NULL);
  if (!thread) return 0;
  SDL_DetachThread(thread); return automation_event;
}
void re_automation_reply(int id, cJSON *result) {
  cJSON *j = cJSON_CreateObject(); cJSON_AddNumberToObject(j, "id", id); cJSON_AddItemToObject(j, "result", result);
  char *text = cJSON_PrintUnformatted(j); if (text) { puts(text); fflush(stdout); free(text); } cJSON_Delete(j);
}
void re_automation_command(ReApp *app, SDL_Window *window, const cJSON *j) {
  const char *op = re_string(j, "op"); int id = re_number(j, "id"); SDL_Event e = {0};
  if (!strcmp(op, "state")) {
    cJSON *state = re_app_inspect(app); ReDraw *draw = re_draw_active();
    if (draw) cJSON_AddStringToObject(state, "backend", re_draw_backend(draw));
    /* The real window title, so a test can hold the chrome and the operating system to the same
     * source rather than assuming they agree (spec 084 decision 4). */
    if (window) cJSON_AddStringToObject(state, "windowTitle", SDL_GetWindowTitle(window));
    cJSON_AddBoolToObject(state, "fileLinkCursor", app->file_link_cursor && SDL_GetCursor() == app->file_link_cursor);
    /* The Dock tile as the OPERATING SYSTEM reports it, beside the window title that already
       follows this rule (spec 084 decision 4): the pixels the platform holds, not the ones we
       believe we sent. A tile we never set still answers — with whatever the process defaulted
       to — which is exactly why the size is what a check compares (spec 136). */
    { int dock_w = 0, dock_h = 0; re_dock_icon_size(&dock_w, &dock_h);
      cJSON *dock = cJSON_AddObjectToObject(state, "dockIcon");
      cJSON_AddNumberToObject(dock, "width", dock_w); cJSON_AddNumberToObject(dock, "height", dock_h); }
    re_automation_reply(id, state); return;
  }
  if (!strcmp(op, "stats")) {
    ReDraw *draw = re_draw_active();
    if (draw && cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "reset"))) re_draw_stats_reset(draw);
    re_automation_reply(id, draw ? re_draw_stats(draw) : cJSON_CreateNull()); return;
  }
  if (!strcmp(op, "theme")) {
    int index = re_draw_theme(re_draw_active(), re_string(j, "name"));
    e.type = SDL_WINDOWEVENT; e.window.event = SDL_WINDOWEVENT_EXPOSED; SDL_PushEvent(&e); /* the switch shows on the next frame */
    re_automation_reply(id, index >= 0 ? cJSON_CreateString(re_theme_preset_names[index]) : cJSON_CreateNull());
    return;
  }
  if (!strcmp(op, "syntax")) {
    int index = re_editor_scheme(re_string(j, "name"));
    e.type = SDL_WINDOWEVENT; e.window.event = SDL_WINDOWEVENT_EXPOSED; SDL_PushEvent(&e);
    re_automation_reply(id, index >= 0 ? cJSON_CreateString(re_scheme_names[index]) : cJSON_CreateNull());
    return;
  }
  if (!strcmp(op, "plugin")) {
    /* Loads a module into this window the way a declaration will (spec 106): the explicitly enabled
       automation channel is the only door until the declaring lane passes the same three inputs. */
    int index = re_app_plugin_load(app, re_string(j, "name"), re_string(j, "path"), re_string(j, "abi"));
    e.type = SDL_WINDOWEVENT; e.window.event = SDL_WINDOWEVENT_EXPOSED; SDL_PushEvent(&e);
    re_automation_reply(id, index >= 0 ? cJSON_CreateTrue() : cJSON_CreateString(app->status)); return;
  }
  /* What the scene drew and where, so the renderer gate can compare BY PRIMITIVE (KI-111). The
     rectangles come from the drawing code rather than from a table beside it, which is what stops
     them drifting the first time a shape moves. */
  if (!strcmp(op, "scene-regions")) {
    cJSON *list = cJSON_CreateArray();
    for (int i = 0; i < re_scene_region_count(); i++) {
      const ReSceneRegion *r = re_scene_region(i);
      cJSON *item = cJSON_CreateObject();
      cJSON_AddStringToObject(item, "name", r->name);
      cJSON_AddNumberToObject(item, "x", r->rect.x); cJSON_AddNumberToObject(item, "y", r->rect.y);
      cJSON_AddNumberToObject(item, "w", r->rect.w); cJSON_AddNumberToObject(item, "h", r->rect.h);
      cJSON_AddItemToArray(list, item);
    }
    re_automation_reply(id, list); return;
  }
  /* Every string the last frame DREW and the box it occupies, optionally narrowed to a rectangle.
     A control's rectangle told a spec that a row existed and nothing about the strings inside it,
     so two strings drawn on top of each other was invisible to every test and plain in a
     screenshot (2026-09-14). Runs are what makes overlap assertable. */
  if (!strcmp(op, "text-runs")) {
    ReDraw *draw = re_draw_active();
    ReDrawList *list = draw ? re_draw_list(draw) : NULL;
    bool scoped = cJSON_HasObjectItem(j, "w") && cJSON_HasObjectItem(j, "h");
    mu_Rect box = mu_rect(re_number(j, "x"), re_number(j, "y"), re_number(j, "w"), re_number(j, "h"));
    /* The clip in force is carried along, because the run a person SEES is the string intersected
       with it. Reporting the unclipped box alone calls a clipped label an overlap; reporting only
       the clipped one calls an elided name whole. Both are here, so a spec can say which it means. */
    mu_Rect clip = mu_rect(0, 0, list ? list->width : 0, list ? list->height : 0);
    cJSON *runs = cJSON_CreateArray();
    for (size_t i = 0; list && i < list->count; i++) {
      const ReCommand *c = &list->commands[i];
      if (c->type == RE_CMD_CLIP) {
        clip = c->flags & RE_CLIP_RESET ? mu_rect(0, 0, list->width, list->height)
                                        : mu_rect(c->rect.x, c->rect.y, c->rect.w, c->rect.h);
        continue;
      }
      if (c->type != RE_CMD_TEXT) continue;
      const char *text = re_draw_list_string(list, c);
      int w = re_draw_text_width(draw, c->face, c->size, text, (int)c->text_length), h = c->size;
      int vx = re_max(c->rect.x, clip.x), vy = re_max(c->rect.y, clip.y);
      int vw = re_max(0, re_min(c->rect.x + w, clip.x + clip.w) - vx);
      int vh = re_max(0, re_min(c->rect.y + h, clip.y + clip.h) - vy);
      if (scoped && (vw == 0 || vh == 0 || vx >= box.x + box.w || vx + vw <= box.x ||
                     vy >= box.y + box.h || vy + vh <= box.y)) continue;
      cJSON *item = cJSON_CreateObject();
      cJSON_AddStringToObject(item, "text", text);
      cJSON_AddNumberToObject(item, "x", c->rect.x); cJSON_AddNumberToObject(item, "y", c->rect.y);
      cJSON_AddNumberToObject(item, "w", w); cJSON_AddNumberToObject(item, "h", h);
      cJSON_AddNumberToObject(item, "face", c->face); cJSON_AddNumberToObject(item, "size", c->size);
      cJSON *seen = cJSON_AddObjectToObject(item, "visible");
      cJSON_AddNumberToObject(seen, "x", vx); cJSON_AddNumberToObject(seen, "y", vy);
      cJSON_AddNumberToObject(seen, "w", vw); cJSON_AddNumberToObject(seen, "h", vh);
      cJSON_AddItemToArray(runs, item);
    }
    re_automation_reply(id, runs); return;
  }
  if (!strcmp(op, "scene")) app->scene = re_scene_id(re_string(j, "name"));
  else
  if (!strcmp(op, "text")) {
    const char *s = re_string(j, "text");
    while (*s) {
      e.type = SDL_TEXTINPUT; int count = 0;
      while (*s) {
        const char *next = s; re_utf8(&next); size_t bytes = (size_t)(next - s);
        if ((size_t)count + bytes >= sizeof(e.text.text)) break;
        memcpy(e.text.text + count, s, bytes); count += (int)bytes; s = next;
      }
      e.text.text[count] = 0; SDL_PushEvent(&e);
    }
  } else if (!strcmp(op, "clipboard")) {
    /* The window's own clipboard, so a spec can drive a real paste: the key event that follows takes
       the same path a person's does, through the event loop's own handler. */
    SDL_SetClipboardText(re_string(j, "text"));
  } else if (!strcmp(op, "key")) {
    e.type = cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(j, "down")) ? SDL_KEYUP : SDL_KEYDOWN;
    e.key.keysym.sym = SDL_GetKeyFromName(re_string(j, "key")); e.key.keysym.scancode = SDL_GetScancodeFromKey(e.key.keysym.sym);
    e.key.keysym.mod = (Uint16)re_number(j, "mod"); SDL_PushEvent(&e);
  } else if (!strcmp(op, "button")) {
    if (cJSON_HasObjectItem(j, "mod")) SDL_SetModState((SDL_Keymod)re_number(j, "mod"));
    e.type = cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(j, "down")) ? SDL_MOUSEBUTTONUP : SDL_MOUSEBUTTONDOWN;
    e.button.button = (Uint8)re_max(1, re_number(j, "button")); e.button.x = re_number(j, "x"); e.button.y = re_number(j, "y"); SDL_PushEvent(&e);
  } else if (!strcmp(op, "motion")) {
    if (cJSON_HasObjectItem(j, "mod")) SDL_SetModState((SDL_Keymod)re_number(j, "mod"));
    e.type = SDL_MOUSEMOTION; e.motion.x = re_number(j, "x"); e.motion.y = re_number(j, "y");
    e.motion.xrel = re_number(j, "dx"); e.motion.yrel = re_number(j, "dy"); SDL_PushEvent(&e);
  } else if (!strcmp(op, "wheel")) {
    if (cJSON_HasObjectItem(j, "mod")) SDL_SetModState((SDL_Keymod)re_number(j, "mod"));
    e.type = SDL_MOUSEWHEEL; e.wheel.x = re_number(j, "x"); e.wheel.y = re_number(j, "y");
    const cJSON *x = cJSON_GetObjectItemCaseSensitive(j, "preciseX"), *y = cJSON_GetObjectItemCaseSensitive(j, "preciseY");
    e.wheel.preciseX = cJSON_IsNumber(x) ? (float)x->valuedouble : (float)e.wheel.x;
    e.wheel.preciseY = cJSON_IsNumber(y) ? (float)y->valuedouble : (float)e.wheel.y;
    e.wheel.direction = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "flipped")) ? SDL_MOUSEWHEEL_FLIPPED : SDL_MOUSEWHEEL_NORMAL;
    SDL_PushEvent(&e);
  } else if (!strcmp(op, "focus")) {
    e.type = SDL_WINDOWEVENT; e.window.event = cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(j, "focused")) ? SDL_WINDOWEVENT_FOCUS_LOST : SDL_WINDOWEVENT_FOCUS_GAINED;
    SDL_PushEvent(&e);
  } else if (!strcmp(op, "resize")) SDL_SetWindowSize(window, re_max(1050, re_number(j, "width")), re_max(480, re_number(j, "height")));
  else if (!strcmp(op, "quit")) { e.type = SDL_QUIT; SDL_PushEvent(&e); }
  else { re_automation_reply(id, cJSON_CreateString("Unknown automation operation")); return; }
  re_automation_reply(id, cJSON_CreateTrue());
}

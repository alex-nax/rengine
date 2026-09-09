#include "automation.h"
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

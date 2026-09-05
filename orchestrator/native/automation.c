#include "automation.h"
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
  if (!strcmp(op, "state")) { re_automation_reply(id, re_app_inspect(app)); return; }
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
    e.type = cJSON_IsFalse(cJSON_GetObjectItemCaseSensitive(j, "down")) ? SDL_MOUSEBUTTONUP : SDL_MOUSEBUTTONDOWN;
    e.button.button = (Uint8)re_max(1, re_number(j, "button")); e.button.x = re_number(j, "x"); e.button.y = re_number(j, "y"); SDL_PushEvent(&e);
  } else if (!strcmp(op, "motion")) {
    e.type = SDL_MOUSEMOTION; e.motion.x = re_number(j, "x"); e.motion.y = re_number(j, "y");
    e.motion.xrel = re_number(j, "dx"); e.motion.yrel = re_number(j, "dy"); SDL_PushEvent(&e);
  } else if (!strcmp(op, "resize")) SDL_SetWindowSize(window, re_max(1050, re_number(j, "width")), re_max(480, re_number(j, "height")));
  else if (!strcmp(op, "quit")) { e.type = SDL_QUIT; SDL_PushEvent(&e); }
  else { re_automation_reply(id, cJSON_CreateString("Unknown automation operation")); return; }
  re_automation_reply(id, cJSON_CreateTrue());
}

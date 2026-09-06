#include "terminal.h"
#include <assert.h>

static int sequence;
static void attach(ReTerminal *t, int cols, int rows, const char *text) {
  cJSON *j = cJSON_CreateObject(), *s = cJSON_AddObjectToObject(j, "session");
  cJSON_AddStringToObject(j, "type", "attached"); cJSON_AddStringToObject(s, "id", "test");
  cJSON_AddNumberToObject(s, "cols", cols); cJSON_AddNumberToObject(s, "rows", rows);
  cJSON_AddNumberToObject(s, "sequence", sequence = 0); cJSON_AddStringToObject(s, "output", text);
  re_terminal_message(t, j); cJSON_Delete(j);
}
static void output(ReTerminal *t, const char *text) {
  cJSON *j = cJSON_CreateObject(); cJSON_AddStringToObject(j, "type", "output");
  cJSON_AddStringToObject(j, "id", "test"); cJSON_AddNumberToObject(j, "sequence", ++sequence);
  cJSON_AddStringToObject(j, "data", text); re_terminal_message(t, j); cJSON_Delete(j);
}
static void key(ReTerminal *t, SDL_Keycode code) {
  SDL_Event e = {.type = SDL_KEYDOWN}; e.key.keysym.sym = code; e.key.keysym.mod = KMOD_SHIFT;
  re_terminal_event(t, &e);
}
static void expect(ReTerminal *t, const char *needle, bool present) {
  char *text = re_terminal_text(t); assert(text);
  if (!!strstr(text, needle) != present) fprintf(stderr, "Expected %s <%s> in <%s>\n", present ? "present" : "absent", needle, text);
  assert(!!strstr(text, needle) == present); free(text);
}
int main(void) {
  for (int axis = 0; axis < 2; axis++) {
    ReScrollbar bar = {0}; mu_Rect track = axis ? mu_rect(20, 20, 100, 14) : mu_rect(20, 20, 14, 100);
    re_scrollbar_set(&bar, track, 1000000, 10, 0, axis != 0);
    SDL_Event event = {.type = SDL_MOUSEBUTTONDOWN}; event.button.button = SDL_BUTTON_LEFT;
    event.button.x = event.button.y = 25;
    assert(re_scrollbar_event(&bar, &event) && bar.dragging);
    event.type = SDL_MOUSEMOTION; event.motion.x = event.motion.y = 500;
    assert(re_scrollbar_event(&bar, &event) && bar.value == 999990);
    event.motion.x = event.motion.y = -500;
    assert(re_scrollbar_event(&bar, &event) && bar.value == 0);
    event.type = SDL_MOUSEBUTTONUP; event.button.button = SDL_BUTTON_LEFT;
    assert(re_scrollbar_event(&bar, &event) && !bar.dragging);
    re_scrollbar_set(&bar, track, 2, 10, 100, axis != 0);
    assert(!bar.track.w && !bar.track.h && bar.value == 0);
  }
  ReTerminal *t = re_terminal_open(NULL, "test", 40, 6); assert(t);
  attach(t, 40, 6, "");
  char line[80];
  for (int i = 0; i < 30; i++) { snprintf(line, sizeof(line), "ROW_%03d café 世界\r\n", i); output(t, line); }
  expect(t, "ROW_029", true); expect(t, "ROW_000", false);
  SDL_Event wheel = {.type = SDL_MOUSEWHEEL}; wheel.wheel.preciseY = 0.2f;
  re_terminal_event(t, &wheel); assert(re_terminal_scroll_state(t).offset == 0);
  re_terminal_event(t, &wheel); assert(re_terminal_scroll_state(t).offset == 1);
  wheel.wheel.preciseY = 1; wheel.wheel.direction = SDL_MOUSEWHEEL_FLIPPED;
  re_terminal_event(t, &wheel); assert(re_terminal_scroll_state(t).offset == 4);
  wheel.wheel.preciseY = -1;
  re_terminal_event(t, &wheel); assert(re_terminal_scroll_state(t).offset == 1);
  key(t, SDLK_HOME); expect(t, "ROW_000 café 世界", true);
  char *before = re_terminal_text(t); output(t, "NEW_OUTPUT\r\n"); char *after = re_terminal_text(t);
  assert(!strcmp(before, after)); free(before); free(after);
  int history = re_terminal_scroll_state(t).lines;
  output(t, "\x1b[?1049h\x1b[2J\x1b[HALTERNATE\r\n");
  for (int i = 0; i < 50; i++) output(t, "ALT_ROW\r\n");
  assert(re_terminal_scroll_state(t).lines == history);
  key(t, SDLK_HOME); assert(re_terminal_scroll_state(t).offset == 0);
  expect(t, "ROW_000", false); output(t, "\x1b[?1049l");
  key(t, SDLK_HOME); expect(t, "ROW_000 café 世界", true);
  key(t, SDLK_END); expect(t, "NEW_OUTPUT", true);
  output(t, "\x1b[3J"); assert(re_terminal_scroll_state(t).lines == 0);
  for (int i = 0; i < 2300; i++) { snprintf(line, sizeof(line), "BOUND_%04d\r\n", i); output(t, line); }
  assert(re_terminal_scroll_state(t).lines == 2000);
  key(t, SDLK_HOME); expect(t, "BOUND_0000", false);
  attach(t, 500, 6, "FRESH\r\n"); assert(re_terminal_scroll_state(t).lines == 0);
  for (int i = 0; i < 1500; i++) output(t, "WIDE\r\n");
  ReTerminalScroll scroll = re_terminal_scroll_state(t);
  assert(scroll.bytes <= 8 * 1024 * 1024 && scroll.lines > 0 && scroll.lines < 1490);
  attach(t, 40, 6, "REATTACHED\r\n"); assert(re_terminal_scroll_state(t).lines == 0);
  expect(t, "REATTACHED", true); expect(t, "WIDE", false);
  re_terminal_close(t); puts("Terminal history, wheel, output anchoring, alternate screen and bounds passed."); return 0;
}

#include "editor.h"
#include <assert.h>

static void key(ReEditor *e, SDL_Keycode code, Uint16 mod) {
  SDL_Event event = {.type = SDL_KEYDOWN}; event.key.keysym.sym = code; event.key.keysym.mod = mod;
  re_editor_event(e, &event, mu_rect(0, 0, 800, 600), 8, 20);
}
static void text(ReEditor *e, const char *s) {
  SDL_Event event = {.type = SDL_TEXTINPUT}; re_copy(event.text.text, sizeof(event.text.text), s);
  re_editor_event(e, &event, mu_rect(0, 0, 800, 600), 8, 20);
}
static void expect(ReEditor *e, const char *s) {
  char *actual = re_editor_text(e);
  if (!actual || strcmp(actual, s)) fprintf(stderr, "Expected: <%s>\nActual: <%s>\n", s, actual ? actual : "allocation failed");
  assert(actual && !strcmp(actual, s)); free(actual);
}
int main(void) {
  ReEditor *e = re_editor_open("first\r\nsecond\r\n"); assert(e);
  re_editor_vim(e, true); key(e, SDLK_g, 0); key(e, SDLK_g, 0); key(e, SDLK_d, 0); key(e, SDLK_d, 0); expect(e, "second\n");
  key(e, SDLK_u, 0); expect(e, "first\nsecond\n");
  key(e, SDLK_g, 0); key(e, SDLK_g, 0);
  key(e, SDLK_i, 0); text(e, "i"); text(e, "é世界"); expect(e, "é世界first\nsecond\n");
  key(e, SDLK_BACKSPACE, 0); expect(e, "é世first\nsecond\n");
  key(e, SDLK_z, KMOD_CTRL); expect(e, "é世界first\nsecond\n");
  key(e, SDLK_ESCAPE, 0); assert(!strcmp(re_editor_mode(e), "Vim NORMAL"));
  re_editor_close(e); puts("Native Vim transition, undo and Unicode codepoint editing passed."); return 0;
}

#ifndef RENGINE_TERMINAL_H
#define RENGINE_TERMINAL_H
#include "draw.h"
#include "net.h"
#include "scroll.h"
typedef struct ReTerminal ReTerminal;
typedef struct { int lines, offset; size_t bytes; } ReTerminalScroll;
ReTerminal *re_terminal_open(ReSocket *socket, const char *id, int cols, int rows);
void re_terminal_close(ReTerminal *terminal);
void re_terminal_attach(ReTerminal *terminal);
void re_terminal_presented(ReTerminal *terminal);
bool re_terminal_ready(ReTerminal *terminal);
ReTerminalScroll re_terminal_scroll_state(ReTerminal *terminal);
void re_terminal_scrollbars(ReTerminal *terminal, cJSON *array);
void re_terminal_inspect_mouse(ReTerminal *terminal, cJSON *object);
bool re_terminal_mouse(ReTerminal *terminal, const SDL_Event *event, int x, int y);
bool re_terminal_mouse_held(ReTerminal *terminal);
void re_terminal_release(ReTerminal *terminal);
void re_terminal_message(ReTerminal *terminal, const cJSON *message);
void re_terminal_event(ReTerminal *terminal, const SDL_Event *event);
void re_terminal_draw(ReTerminal *terminal, ReDraw *draw, mu_Rect rect, bool focused);
char *re_terminal_text(ReTerminal *terminal);
bool re_terminal_file_at(ReTerminal *terminal, int x, int y, char *target, size_t capacity);
#endif

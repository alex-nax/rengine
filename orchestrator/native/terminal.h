#ifndef RENGINE_TERMINAL_H
#define RENGINE_TERMINAL_H
#include "draw.h"
#include "net.h"
typedef struct ReTerminal ReTerminal;
ReTerminal *re_terminal_open(ReSocket *socket, const char *id, int cols, int rows);
void re_terminal_close(ReTerminal *terminal);
void re_terminal_attach(ReTerminal *terminal);
void re_terminal_presented(ReTerminal *terminal);
void re_terminal_message(ReTerminal *terminal, const cJSON *message);
void re_terminal_event(ReTerminal *terminal, const SDL_Event *event);
void re_terminal_draw(ReTerminal *terminal, ReDraw *draw, mu_Rect rect, bool focused);
char *re_terminal_text(ReTerminal *terminal);
#endif

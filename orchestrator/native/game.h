#ifndef RENGINE_GAME_H
#define RENGINE_GAME_H
#include "draw.h"
#include "net.h"
typedef struct {
  ReSocket *socket; SDL_Texture *texture; int width, height, sequence;
  mu_Rect rect; bool focused, captured; Uint32 buttons; char status[256];
} ReGame;
ReGame *re_game_open(ReNet *net, const char *id);
void re_game_close(ReGame *game);
void re_game_tick(ReGame *game, ReDraw *draw);
void re_game_draw(ReGame *game, ReDraw *draw, mu_Rect rect);
void re_game_capture(ReGame *game);
void re_game_release(ReGame *game);
void re_game_event(ReGame *game, const SDL_Event *event);
#endif

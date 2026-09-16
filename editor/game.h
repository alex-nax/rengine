#ifndef RENGINE_GAME_H
#define RENGINE_GAME_H
#include "draw.h"
#include "net.h"
/* A validated frame is handed to one sink before it is freed, so the recorder writes down the
   stream the pane already receives rather than opening a second one (spec 081). */
typedef void (*ReGameFrame)(void *user, const unsigned char *rgba, int width, int height, int sequence);
typedef struct {
  ReSocket *socket; ReTexture *texture; int width, height, sequence;
  mu_Rect rect; bool focused, captured; Uint32 buttons; char status[256];
  ReGameFrame sink; void *sink_user;
} ReGame;
ReGame *re_game_open(ReNet *net, const char *id);
void re_game_close(ReGame *game);
void re_game_tick(ReGame *game, ReDraw *draw);
void re_game_draw(ReGame *game, ReDraw *draw, mu_Rect rect);
void re_game_capture(ReGame *game);
void re_game_release(ReGame *game);
void re_game_event(ReGame *game, const SDL_Event *event);
void re_game_sink(ReGame *game, ReGameFrame sink, void *user);
#endif

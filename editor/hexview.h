#ifndef RENGINE_HEXVIEW_H
#define RENGINE_HEXVIEW_H
#include "common.h"   /* SDL_Event and friends: named below, so included here */
#include "draw.h"
#include "scroll.h"
#define RE_HEX_WINDOW 65536
#define RE_HEX_COLUMNS 16
typedef struct ReHexView ReHexView;
ReHexView *re_hex_open(void);
void re_hex_close(ReHexView *view);
bool re_hex_set(ReHexView *view, const char *hex, long long base, long long size); /* hex = lowercase pairs from the service */
void re_hex_clear(ReHexView *view);
bool re_hex_loaded(const ReHexView *view);
long long re_hex_base(const ReHexView *view);
long long re_hex_size(const ReHexView *view);
int re_hex_length(const ReHexView *view);
int re_hex_rows(const ReHexView *view);
void re_hex_row(const ReHexView *view, int row, char *text, size_t size);
void re_hex_event(ReHexView *view, const SDL_Event *event, mu_Rect rect, int lh);
void re_hex_draw(ReHexView *view, ReDraw *draw, mu_Rect rect);
void re_hex_inspect(const ReHexView *view, cJSON *object);
#endif

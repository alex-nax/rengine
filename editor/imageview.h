#ifndef RENGINE_IMAGEVIEW_H
#define RENGINE_IMAGEVIEW_H
#include "common.h"   /* SDL_Event and friends: named below, so included here */
#include "draw.h"
typedef struct ReImageView ReImageView;
bool re_image_path(const char *path);
ReImageView *re_image_open(void);
void re_image_close(ReImageView *view);
void re_image_clear(ReImageView *view);
bool re_image_load(ReImageView *view, const void *bytes, size_t size, char *error, size_t capacity);
void re_image_actual(ReImageView *view, bool actual);
bool re_image_is_actual(const ReImageView *view);
void re_image_event(ReImageView *view, const SDL_Event *event);
void re_image_draw(ReImageView *view, ReDraw *draw, mu_Rect rect);
cJSON *re_image_inspect(const ReImageView *view);
void re_image_dimensions(const ReImageView *view, char *text, size_t size);
#endif

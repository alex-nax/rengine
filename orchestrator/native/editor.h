#ifndef RENGINE_EDITOR_H
#define RENGINE_EDITOR_H
#include "draw.h"
#include "scroll.h"
typedef struct ReEditor ReEditor;
ReEditor *re_editor_open(const char *text);
void re_editor_close(ReEditor *editor);
char *re_editor_text(ReEditor *editor);
int re_editor_revision(const ReEditor *editor);
void re_editor_vim(ReEditor *editor, bool enabled);
void re_editor_readonly(ReEditor *editor, bool enabled);
const char *re_editor_mode(const ReEditor *editor);
void re_editor_scrollbars(ReEditor *editor, cJSON *array);
void re_editor_event(ReEditor *editor, const SDL_Event *event, mu_Rect rect, int cw, int lh);
void re_editor_draw(ReEditor *editor, ReDraw *draw, mu_Rect rect, bool focused);
#endif

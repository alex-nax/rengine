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
void re_editor_language(ReEditor *editor, const char *filename); /* syntax language from the file name */
int re_editor_scheme(const char *name);                          /* colour scheme by name; index, or -1 */
const char *re_editor_mode(const ReEditor *editor);
void re_editor_scrollbars(ReEditor *editor, cJSON *array);
/* Where the caret is, in the units the Language Server Protocol and Claude Code both count: lines
 * from zero, and characters as UTF-16 code units rather than bytes or code points. With nothing
 * selected, start and end are the caret. `text` receives the selected text, truncated to `size`. */
typedef struct { int start_line, start_character, end_line, end_character; } ReSelection;
void re_editor_selection(const ReEditor *editor, ReSelection *selection, char *text, int size);
void re_editor_event(ReEditor *editor, const SDL_Event *event, mu_Rect rect, int cw, int lh);
void re_editor_draw(ReEditor *editor, ReDraw *draw, mu_Rect rect, bool focused);
#endif

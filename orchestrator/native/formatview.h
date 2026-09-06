#ifndef RENGINE_FORMATVIEW_H
#define RENGINE_FORMATVIEW_H
#include "hexview.h"
#include "editor.h"
enum { RE_MODE_TEXT = 0, RE_MODE_RAW, RE_MODE_PREVIEW, RE_MODE_PENDING };
enum { RE_FORMAT_NONE = 0, RE_FORMAT_MODE, RE_FORMAT_LOAD, RE_FORMAT_ENTRY, RE_FORMAT_PAGE };
typedef struct ReApp ReApp;
typedef struct ReFormatView ReFormatView;
ReFormatView *re_format_open(int mode, bool chosen);
void re_format_close(ReFormatView *view);
int re_format_mode(const ReFormatView *view);
bool re_format_chosen(const ReFormatView *view);
int re_format_requested(const ReFormatView *view);
const char *re_format_mode_name(int mode);
int re_format_mode_from(const char *name);
void re_format_set_mode(ReFormatView *view, int mode, bool chosen);
void re_format_assign(ReFormatView *view, const char *id, const char *title);
const char *re_format_id(const ReFormatView *view);
const char *re_format_entry(const ReFormatView *view);
long long re_format_offset(const ReFormatView *view, bool entry);
void re_format_name_command(ReFormatView *view, const cJSON *spec, bool entry);
bool re_format_glob(const char *glob, const char *name);
const cJSON *re_format_match(const cJSON *formats, const char *name);
bool re_format_bytes(ReFormatView *view, const cJSON *result);
bool re_format_result(ReFormatView *view, const cJSON *result);
void re_format_entry_failed(ReFormatView *view, const char *error);
bool re_format_scrolls(const ReFormatView *view);
bool re_format_split(const ReFormatView *view);
int re_format_ui(ReFormatView *view, ReApp *app, mu_Context *ui, const cJSON *record, int tab, const char *error);
void re_format_event(ReFormatView *view, const SDL_Event *event, mu_Rect rect, int cw, int lh);
void re_format_draw(ReFormatView *view, ReDraw *draw, mu_Rect rect, bool focused);
void re_format_inspect(const ReFormatView *view, cJSON *tab);
#endif

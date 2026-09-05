#ifndef RENGINE_LAYOUT_H
#define RENGINE_LAYOUT_H
#include "common.h"
#define RE_PANES 29
#define RE_TABS 64
typedef struct {
  bool used;
  int axis, child[2];
  float ratio;
  int tabs[RE_TABS], count, selected;
  mu_Rect rect, divider;
} RePane;
typedef struct { RePane panes[RE_PANES]; int active; } ReLayout;
void re_layout_init(ReLayout *layout);
void re_layout_measure(ReLayout *layout, mu_Rect rect);
int re_layout_split(ReLayout *layout, int pane, int axis);
int re_layout_collapse(ReLayout *layout, int pane);
bool re_layout_add(ReLayout *layout, int pane, int tab);
bool re_layout_remove(ReLayout *layout, int tab);
bool re_layout_move(ReLayout *layout, int tab, int pane, int index);
int re_layout_find(const ReLayout *layout, int tab);
int re_layout_hit(const ReLayout *layout, int x, int y, bool divider);
cJSON *re_layout_json(const ReLayout *layout);
bool re_layout_restore(ReLayout *layout, const cJSON *json);
#endif

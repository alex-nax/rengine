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
/* The pane a document should open into, given a most-recent-first list of pane indices, the pane the
   open was issued from, and `avoid[RE_PANES]` marking panes that should not receive one — the caller
   marks the panes currently showing a browser, because dropping a document on one is the thing this
   rule exists to stop. The answer is the most recently used leaf that is neither `from` nor avoided;
   the largest such leaf by area when no history names one; and `from` itself when there is no other
   at all, which is what a single-pane window means (spec 130). Entries in `mru` that are no longer
   leaves are skipped, so a stale one cannot send a view into a split node. */
int re_layout_open_target(const ReLayout *layout, const int *mru, int count, int from, const bool *avoid);
int re_layout_hit(const ReLayout *layout, int x, int y, bool divider);
cJSON *re_layout_json(const ReLayout *layout);
bool re_layout_restore(ReLayout *layout, const cJSON *json);
#endif

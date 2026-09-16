#include "layout.h"
#include <assert.h>

int main(void) {
  ReLayout l; re_layout_init(&l);
  assert(re_layout_add(&l, 0, 10));
  assert(!re_layout_add(&l, 0, 10));
  assert(re_layout_add(&l, 0, 11));
  int right = re_layout_split(&l, 0, 1);
  assert(right > 0 && re_layout_find(&l, 10) != right);
  assert(re_layout_move(&l, 10, right, 0));
  int lower = re_layout_split(&l, right, 2);
  assert(lower > 0 && re_layout_find(&l, 10) != lower);
  re_layout_measure(&l, mu_rect(0, 0, 1000, 800));
  assert(l.panes[lower].rect.x > 400 && l.panes[lower].rect.y > 300);
  assert(re_layout_hit(&l, 800, 600, false) == lower);
  assert(re_layout_hit(&l, 500, 200, true) == 0);
  int before = re_layout_find(&l, 10);
  assert(!re_layout_move(&l, 10, 0, 0));
  assert(re_layout_find(&l, 10) == before);
  cJSON *state = re_layout_json(&l); ReLayout restored;
  assert(re_layout_restore(&restored, state));
  assert(re_layout_find(&restored, 10) == before);
  assert(re_layout_remove(&restored, 10));
  assert(re_layout_find(&restored, 10) < 0);
  assert(!re_layout_remove(&restored, 10));
  cJSON *nodes = cJSON_GetObjectItemCaseSensitive(state, "panes");
  cJSON *root = cJSON_GetArrayItem(nodes, 0);
  cJSON *children = cJSON_GetObjectItemCaseSensitive(root, "children");
  cJSON_ReplaceItemInArray(children, 0, cJSON_CreateNumber(0));
  assert(!re_layout_restore(&restored, state));
  cJSON_Delete(state);
  re_layout_init(&l);
  int target = 0, splits = 0;
  while ((target = re_layout_split(&l, target, 1)) >= 0) splits++;
  assert(splits == 14);
  re_layout_init(&l);
  assert(re_layout_collapse(&l, 0) == -1);
  assert(re_layout_add(&l, 0, 1)); assert(re_layout_add(&l, 0, 2));
  right = re_layout_split(&l, 0, 1);
  assert(re_layout_add(&l, right, 3)); assert(re_layout_add(&l, right, 4));
  int left = re_layout_find(&l, 1);
  lower = re_layout_split(&l, right, 2);
  assert(re_layout_add(&l, lower, 5));
  int merged = re_layout_collapse(&l, left);
  assert(merged == re_layout_find(&l, 3) && l.panes[0].axis == 2);
  assert(re_layout_find(&l, 1) == merged && re_layout_find(&l, 2) == merged);
  assert(l.panes[merged].count == 4 && l.panes[merged].tabs[l.panes[merged].selected] == 2);
  assert(re_layout_find(&l, 5) == lower);
  assert(re_layout_move(&l, 2, merged, 0));
  assert(l.panes[merged].tabs[0] == 2 && l.panes[merged].count == 4);
  assert(re_layout_collapse(&l, lower) == 0);
  assert(l.panes[0].count == 5 && l.panes[0].tabs[l.panes[0].selected] == 5);
  state = re_layout_json(&l); assert(re_layout_restore(&restored, state)); cJSON_Delete(state);
  assert(re_layout_split(&l, 0, 1) > 0);
  assert(re_layout_collapse(&l, l.active) == 0 && l.panes[0].count == 5);
  puts("Native split/move/root-preserving layout and corrupt-state rejection passed.");
  /* Where a document opens (spec 130). The rule is the most recently used leaf that is not the pane
     the open came from, so a file chosen in the explorer lands in the pane being worked in.
     Splitting pane n turns n into the parent and puts the old contents in child[0]. */
  {
    ReLayout t; re_layout_init(&t);
    int alone[] = {0};
    assert(re_layout_open_target(&t, alone, 1, 0, NULL) == 0);        /* one pane: a new tab beside it */

    int right = re_layout_split(&t, 0, 1), left = t.panes[0].child[0];
    int two[] = {right, left};
    assert(re_layout_open_target(&t, two, 2, left, NULL) == right);   /* two panes: always the other one */
    assert(re_layout_open_target(&t, two, 2, right, NULL) == left);

    int lower = re_layout_split(&t, right, 2), upper = t.panes[right].child[0];
    int worked[] = {left, lower, upper};             /* the explorer is current, `lower` was before it */
    assert(re_layout_open_target(&t, worked, 3, left, NULL) == lower);
    int stale[] = {left, right, upper};    /* `right` is a split node now: skipped, never opened into */
    assert(re_layout_open_target(&t, stale, 3, left, NULL) == upper);

    /* A pane the caller marks as a browser is never the answer, even when it is the most recent: a
       document sent to the explorer's pane is the defect this rule exists to prevent, and the
       explorer is usually the pane used just before the browser that issued the open. */
    bool avoid[RE_PANES] = {false};
    avoid[lower] = true;
    assert(re_layout_open_target(&t, worked, 3, left, avoid) == upper);
    avoid[upper] = true;                 /* nowhere left but the pane it came from */
    assert(re_layout_open_target(&t, worked, 3, left, avoid) == left);

    re_layout_measure(&t, mu_rect(0, 0, 1000, 800));
    int unknown[] = {left};                /* no history names another leaf: the largest one, by area */
    int guess = re_layout_open_target(&t, unknown, 1, left, NULL);
    assert(guess == upper || guess == lower);
    assert(t.panes[guess].rect.w * t.panes[guess].rect.h >=
           t.panes[guess == upper ? lower : upper].rect.w * t.panes[guess == upper ? lower : upper].rect.h);
  }

  return 0;
}

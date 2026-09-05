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
  return 0;
}

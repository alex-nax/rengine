#include "layout.h"
#include <math.h>

void re_layout_init(ReLayout *l) {
  memset(l, 0, sizeof(*l)); l->panes[0].used = true;
}
static bool leaf(const ReLayout *l, int n) {
  return n >= 0 && n < RE_PANES && l->panes[n].used && l->panes[n].axis == 0;
}
int re_layout_find(const ReLayout *l, int tab) {
  for (int n = 0; n < RE_PANES; n++) if (leaf(l, n))
    for (int t = 0; t < l->panes[n].count; t++) if (l->panes[n].tabs[t] == tab) return n;
  return -1;
}
int re_layout_open_target(const ReLayout *l, const int *mru, int count, int from, const bool *avoid) {
  for (int i = 0; i < count; i++)
    if (mru[i] != from && leaf(l, mru[i]) && !(avoid && avoid[mru[i]])) return mru[i];
  /* No history names another leaf. The largest by area is the best guess left, and it is the one a
     person would point at: a fresh split has equal halves, so this only decides odd layouts. */
  int best = -1; long area = -1;
  for (int n = 0; n < RE_PANES; n++) {
    if (n == from || !leaf(l, n) || (avoid && avoid[n])) continue;
    long size = (long)l->panes[n].rect.w * l->panes[n].rect.h;
    if (size > area) { area = size; best = n; }
  }
  return best >= 0 ? best : from;
}
bool re_layout_add(ReLayout *l, int n, int tab) {
  if (!leaf(l, n) || tab < 0 || tab >= RE_TABS || re_layout_find(l, tab) >= 0) return false;
  RePane *p = &l->panes[n];
  if (p->count == RE_TABS) return false;
  p->tabs[p->count++] = tab; p->selected = p->count - 1; l->active = n; return true;
}
bool re_layout_remove(ReLayout *l, int tab) {
  int n = re_layout_find(l, tab);
  if (n < 0) return false;
  RePane *p = &l->panes[n]; int at = 0;
  while (p->tabs[at] != tab) at++;
  memmove(p->tabs + at, p->tabs + at + 1, (size_t)(p->count - at - 1) * sizeof(int));
  p->count--;
  if (p->selected > at) p->selected--;
  p->selected = re_max(0, re_min(p->selected, p->count - 1));
  return true;
}
bool re_layout_move(ReLayout *l, int tab, int n, int index) {
  if (!leaf(l, n) || re_layout_find(l, tab) < 0) return false;
  RePane *p = &l->panes[n];
  if (p->count == RE_TABS && re_layout_find(l, tab) != n) return false;
  re_layout_remove(l, tab); index = re_max(0, re_min(index, p->count));
  memmove(p->tabs + index + 1, p->tabs + index, (size_t)(p->count - index) * sizeof(int));
  p->tabs[index] = tab; p->count++; p->selected = index; l->active = n; return true;
}
int re_layout_split(ReLayout *l, int n, int axis) {
  if (!leaf(l, n) || (axis != 1 && axis != 2)) return -1;
  int a = -1, b = -1;
  for (int i = 1; i < RE_PANES; i++) if (!l->panes[i].used) {
    if (a < 0) a = i; else { b = i; break; }
  }
  if (b < 0) return -1;
  l->panes[a] = l->panes[n]; memset(&l->panes[b], 0, sizeof(RePane)); l->panes[b].used = true;
  RePane *p = &l->panes[n]; memset(p, 0, sizeof(*p));
  p->used = true; p->axis = axis; p->child[0] = a; p->child[1] = b; p->ratio = 0.5f;
  l->active = b; return b;
}
int re_layout_collapse(ReLayout *l, int n) {
  if (!leaf(l, n) || n == 0) return -1;
  int parent = -1, sibling = -1;
  for (int i = 0; i < RE_PANES; i++) if (l->panes[i].used && l->panes[i].axis) {
    if (l->panes[i].child[0] == n) { parent = i; sibling = l->panes[i].child[1]; break; }
    if (l->panes[i].child[1] == n) { parent = i; sibling = l->panes[i].child[0]; break; }
  }
  if (parent < 0) return -1;
  int target = sibling;
  while (l->panes[target].axis) target = l->panes[target].child[0];
  RePane *from = &l->panes[n], *to = &l->panes[target];
  if (to->count + from->count > RE_TABS) return -1;
  if (from->count) to->selected = to->count + from->selected;
  memcpy(to->tabs + to->count, from->tabs, (size_t)from->count * sizeof(int)); to->count += from->count;
  l->panes[parent] = l->panes[sibling];
  memset(&l->panes[n], 0, sizeof(RePane)); memset(&l->panes[sibling], 0, sizeof(RePane));
  l->active = target == sibling ? parent : target; return l->active;
}
static void measure(ReLayout *l, int n, mu_Rect r) {
  RePane *p = &l->panes[n]; p->rect = r;
  if (!p->axis) return;
  int extent = p->axis == 1 ? r.w : r.h;
  int gap = re_min(RE_METRIC_WORKSPACE_DIVIDER, re_max(0, extent));
  int available = re_max(0, extent - gap), minimum = re_min(RE_METRIC_WORKSPACE_PANE_MINIMUM, available / 2);
  int first = re_max(minimum, re_min((int)(available * p->ratio), available - minimum));
  mu_Rect a = r, b = r; p->divider = r;
  if (p->axis == 1) {
    a.w = first; b.x += first + gap; b.w = available - first;
    p->divider.x += first; p->divider.w = gap;
  } else {
    a.h = first; b.y += first + gap; b.h = available - first;
    p->divider.y += first; p->divider.h = gap;
  }
  measure(l, p->child[0], a); measure(l, p->child[1], b);
}
void re_layout_measure(ReLayout *l, mu_Rect r) { measure(l, 0, r); }
int re_layout_hit(const ReLayout *l, int x, int y, bool divider) {
  for (int n = 0; n < RE_PANES; n++) {
    const RePane *p = &l->panes[n];
    if (p->used && (divider ? p->axis != 0 : p->axis == 0) && re_inside(divider ? p->divider : p->rect, x, y)) return n;
  }
  return -1;
}
cJSON *re_layout_json(const ReLayout *l) {
  cJSON *j = cJSON_CreateObject(), *nodes = cJSON_AddArrayToObject(j, "panes");
  cJSON_AddNumberToObject(j, "version", 1); cJSON_AddNumberToObject(j, "active", l->active);
  for (int n = 0; n < RE_PANES; n++) {
    const RePane *p = &l->panes[n];
    if (!p->used) { cJSON_AddItemToArray(nodes, cJSON_CreateNull()); continue; }
    cJSON *node = cJSON_CreateObject(); cJSON_AddItemToArray(nodes, node);
    cJSON_AddNumberToObject(node, "axis", p->axis); cJSON_AddNumberToObject(node, "ratio", p->ratio);
    cJSON_AddItemToObject(node, "children", cJSON_CreateIntArray(p->child, 2));
    cJSON_AddItemToObject(node, "tabs", cJSON_CreateIntArray(p->tabs, p->count));
    cJSON_AddNumberToObject(node, "selected", p->selected);
  }
  return j;
}
static bool number(const cJSON *v, int low, int high, int *result) {
  if (!cJSON_IsNumber(v) || !isfinite(v->valuedouble) || v->valuedouble < low || v->valuedouble > high || floor(v->valuedouble) != v->valuedouble) return false;
  *result = (int)v->valuedouble; return true;
}
static bool visit(const ReLayout *l, int n, bool seen[RE_PANES]) {
  if (n < 0 || n >= RE_PANES || seen[n] || !l->panes[n].used) return false;
  seen[n] = true;
  const RePane *p = &l->panes[n];
  return !p->axis || (visit(l, p->child[0], seen) && visit(l, p->child[1], seen));
}
bool re_layout_restore(ReLayout *l, const cJSON *j) {
  ReLayout candidate = {0}; bool tabs[RE_TABS] = {0}, seen[RE_PANES] = {0}; int version;
  if (!number(cJSON_GetObjectItemCaseSensitive(j, "version"), 1, 1, &version) ||
      !number(cJSON_GetObjectItemCaseSensitive(j, "active"), 0, RE_PANES - 1, &candidate.active)) return false;
  const cJSON *nodes = cJSON_GetObjectItemCaseSensitive(j, "panes");
  if (!cJSON_IsArray(nodes) || cJSON_GetArraySize(nodes) != RE_PANES) return false;
  for (int n = 0; n < RE_PANES; n++) {
    const cJSON *node = cJSON_GetArrayItem(nodes, n); RePane *p = &candidate.panes[n];
    if (cJSON_IsNull(node)) continue;
    p->used = true;
    if (!cJSON_IsObject(node) || !number(cJSON_GetObjectItemCaseSensitive(node, "axis"), 0, 2, &p->axis)) return false;
    const cJSON *ratio = cJSON_GetObjectItemCaseSensitive(node, "ratio");
    if (!cJSON_IsNumber(ratio) || !isfinite(ratio->valuedouble) || ratio->valuedouble < 0 || ratio->valuedouble > 1) return false;
    p->ratio = (float)ratio->valuedouble;
    const cJSON *children = cJSON_GetObjectItemCaseSensitive(node, "children");
    if (!cJSON_IsArray(children) || cJSON_GetArraySize(children) != 2) return false;
    for (int k = 0; k < 2; k++) if (!number(cJSON_GetArrayItem(children, k), 0, RE_PANES - 1, &p->child[k])) return false;
    const cJSON *list = cJSON_GetObjectItemCaseSensitive(node, "tabs");
    if (!cJSON_IsArray(list) || (p->count = cJSON_GetArraySize(list)) > RE_TABS || (p->axis && p->count)) return false;
    for (int k = 0; k < p->count; k++) {
      if (!number(cJSON_GetArrayItem(list, k), 0, RE_TABS - 1, &p->tabs[k]) || tabs[p->tabs[k]]) return false;
      tabs[p->tabs[k]] = true;
    }
    if (!number(cJSON_GetObjectItemCaseSensitive(node, "selected"), 0, re_max(0, p->count - 1), &p->selected)) return false;
  }
  if (!visit(&candidate, 0, seen) || !leaf(&candidate, candidate.active)) return false;
  for (int n = 0; n < RE_PANES; n++) if (candidate.panes[n].used != seen[n]) return false;
  *l = candidate; return true;
}

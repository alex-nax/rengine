#ifndef RENGINE_COMMON_H
#define RENGINE_COMMON_H
#include <SDL.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "microui.h"
#include "theme.h"
#include "cJSON.h"

#define RE_ARRAY_SIZE(a) ((int)(sizeof(a) / sizeof((a)[0])))
static inline const char *re_string(const cJSON *j, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(j, key);
  return cJSON_IsString(v) ? v->valuestring : "";
}
static inline int re_number(const cJSON *j, const char *key) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(j, key);
  return cJSON_IsNumber(v) ? v->valueint : 0;
}
static inline void re_copy(char *dst, size_t size, const char *src) {
  if (size) snprintf(dst, size, "%s", src ? src : "");
}
static inline bool re_inside(mu_Rect r, int x, int y) {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}
static inline int re_min(int a, int b) { return a < b ? a : b; }
static inline int re_max(int a, int b) { return a > b ? a : b; }
uint32_t re_utf8(const char **text);
int re_encode(uint32_t cp, char bytes[5]);
#endif

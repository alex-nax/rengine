#include "theme_file.h"
#include "theme.h"
#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RE_OVERRIDES 160
#define RE_GRAY_STEPS 11

typedef struct { char name[64], value[192]; } Override;
static struct { Override items[RE_OVERRIDES]; int count; float hue; char name[64]; } file;

static void trim(char *s) {
  char *end = s + strlen(s);
  while (end > s && isspace((unsigned char)end[-1])) *--end = 0;
  char *start = s; while (*start && isspace((unsigned char)*start)) start++;
  if (start != s) memmove(s, start, strlen(start) + 1);
}
static void put(const char *name, const char *value) {
  for (int i = 0; i < file.count; i++) if (!strcmp(file.items[i].name, name)) {
    snprintf(file.items[i].value, sizeof(file.items[i].value), "%s", value); return;
  }
  if (file.count >= RE_OVERRIDES) return;
  snprintf(file.items[file.count].name, sizeof(file.items[file.count].name), "%s", name);
  snprintf(file.items[file.count].value, sizeof(file.items[file.count].value), "%s", value);
  file.count++;
}

/* A key names a token. The card writes them without the layer prefix when the layer is obvious, so
 * a bare key is tried as itself, then under the palette prefix, then the semantic one. */
static bool known(const char *name) {
  const ReToken *tokens = re_theme_tokens[re_theme_preset];
  for (int i = 0; i < re_theme_token_counts[re_theme_preset]; i++) if (!strcmp(tokens[i].name, name)) return true;
  return false;
}
static bool token_for(const char *key, char *out, size_t size) {
  const char *prefixes[] = {"--", "--re-", "--ui-"};
  for (int i = 0; i < 3; i++) {
    snprintf(out, size, "%s%s", prefixes[i], key);
    if (known(out)) return true;
  }
  return false;
}

static bool assignment(const char *line, char *key, size_t key_size, char *value, size_t value_size) {
  const char *equals = strchr(line, '=');
  if (!equals) return false;
  size_t length = (size_t)(equals - line);
  if (length >= key_size) length = key_size - 1;
  memcpy(key, line, length); key[length] = 0; trim(key);
  snprintf(value, value_size, "%s", equals + 1); trim(value);
  return *key != 0;
}

/* `gray = c0 c1 … c10` sets the whole palette ramp, which is how the card writes an editor theme. */
static int spread_gray(const char *value) {
  char buffer[192]; snprintf(buffer, sizeof(buffer), "%s", value);
  int step = 0;
  for (char *save = NULL, *word = strtok_r(buffer, " \t", &save); word && step < RE_GRAY_STEPS; word = strtok_r(NULL, " \t", &save)) {
    char name[64]; snprintf(name, sizeof(name), "--re-gray-%d", step++);
    put(name, word);
  }
  return step;
}

static const char *value_of(const char *name) {
  for (int i = 0; i < file.count; i++) if (!strcmp(file.items[i].name, name)) return file.items[i].value;
  const ReToken *tokens = re_theme_tokens[re_theme_preset];
  for (int i = 0; i < re_theme_token_counts[re_theme_preset]; i++) if (!strcmp(tokens[i].name, name)) return tokens[i].value;
  return NULL;
}

/* Expands var() the way the stylesheet does, so an override anywhere in a chain reaches the field. */
static bool expand(const char *expression, char *out, size_t size, int depth) {
  if (!expression || depth > 8) return false;
  size_t used = 0;
  for (const char *p = expression; *p;) {
    if (!strncmp(p, "var(", 4)) {
      const char *start = p + 4, *end = start;
      int nesting = 1;
      while (*end && nesting) { if (*end == '(') nesting++; else if (*end == ')') nesting--; if (nesting) end++; }
      char name[64]; size_t length = (size_t)(end - start);
      const char *comma = memchr(start, ',', length);   /* a fallback: the token still wins */
      if (comma) length = (size_t)(comma - start);
      if (length >= sizeof(name)) length = sizeof(name) - 1;
      memcpy(name, start, length); name[length] = 0; trim(name);
      char nested[192];
      if (!expand(value_of(name), nested, sizeof(nested), depth + 1)) return false;
      size_t n = strlen(nested);
      if (used + n >= size) return false;
      memcpy(out + used, nested, n); used += n;
      p = *end ? end + 1 : end;
    } else {
      if (used + 1 >= size) return false;
      out[used++] = *p++;
    }
  }
  out[used] = 0;
  return true;
}

static int hex_digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
static bool parse_channels(const char *text, float *out, int wanted, int *found) {
  int count = 0;
  const char *p = text;
  while (*p && count < wanted) {
    while (*p && (isspace((unsigned char)*p) || *p == ',' || *p == '/')) p++;
    if (!*p || *p == ')') break;
    char *end = NULL; float value = strtof(p, &end);
    if (end == p) return false;
    if (*end == '%') { value /= 100.0f; end++; }
    out[count++] = value; p = end;
  }
  *found = count;
  return count > 0;
}
static bool parse_color(const char *text, mu_Color *out) {
  char buffer[192]; snprintf(buffer, sizeof(buffer), "%s", text); trim(buffer);
  if (!strcmp(buffer, "transparent")) { out->r = out->g = out->b = out->a = 0; return true; }
  if (buffer[0] == '#') {
    const char *digits = buffer + 1; size_t length = strlen(digits);
    if (length != 3 && length != 4 && length != 6 && length != 8) return false;
    int values[4] = {0, 0, 0, 255};
    for (size_t i = 0; i < length; i++) if (hex_digit(digits[i]) < 0) return false;
    if (length <= 4) for (size_t i = 0; i < length; i++) values[i] = hex_digit(digits[i]) * 17;
    else for (size_t i = 0; i < length / 2; i++) values[i] = hex_digit(digits[i * 2]) * 16 + hex_digit(digits[i * 2 + 1]);
    out->r = (unsigned char)values[0]; out->g = (unsigned char)values[1];
    out->b = (unsigned char)values[2]; out->a = (unsigned char)values[3];
    return true;
  }
  float channels[4] = {0, 0, 0, 1};
  int found = 0;
  if (!strncmp(buffer, "rgb", 3)) {
    const char *open = strchr(buffer, '(');
    if (!open || !parse_channels(open + 1, channels, 4, &found) || found < 3) return false;
    out->r = (unsigned char)(channels[0] < 0 ? 0 : channels[0] > 255 ? 255 : channels[0]);
    out->g = (unsigned char)(channels[1] < 0 ? 0 : channels[1] > 255 ? 255 : channels[1]);
    out->b = (unsigned char)(channels[2] < 0 ? 0 : channels[2] > 255 ? 255 : channels[2]);
    out->a = (unsigned char)((found > 3 ? channels[3] : 1.0f) * 255.0f + 0.5f);
    return true;
  }
  if (!strncmp(buffer, "oklch", 5)) {
    const char *open = strchr(buffer, '(');
    if (!open || !parse_channels(open + 1, channels, 4, &found) || found < 3) return false;
    *out = re_theme_from_oklch(channels[0], channels[1], channels[2],
                               (unsigned char)((found > 3 ? channels[3] : 1.0f) * 255.0f + 0.5f));
    return true;
  }
  return false;
}

float re_theme_file_hue(void) { return file.hue; }
const char *re_theme_file_name(void) { return file.name; }

bool re_theme_file_apply(const char *text, char *message, size_t size) {
  if (!text) { snprintf(message, size, "That theme file is empty."); return false; }
  file.count = 0; file.hue = -1.0f; file.name[0] = 0;
  int assignments = 0, unknown = 0;
  char line[256];
  const char *p = text;
  bool header = false;
  while (*p) {
    const char *end = strchr(p, '\n');
    size_t length = end ? (size_t)(end - p) : strlen(p);
    if (length >= sizeof(line)) length = sizeof(line) - 1;
    memcpy(line, p, length); line[length] = 0; trim(line);
    p = end ? end + 1 : p + strlen(p);
    if (!*line || *line == '#' || *line == ';') continue;
    if (*line == '[') {
      const char *quote = strchr(line, '"');
      if (!quote) continue;
      const char *close = strchr(quote + 1, '"');
      size_t n = close ? (size_t)(close - quote - 1) : 0;
      if (n >= sizeof(file.name)) n = sizeof(file.name) - 1;
      memcpy(file.name, quote + 1, n); file.name[n] = 0;
      header = true;
      continue;
    }
    char key[64], value[192];
    if (!assignment(line, key, sizeof(key), value, sizeof(value))) continue;
    if (!strcmp(key, "gray")) { assignments += spread_gray(value); continue; }
    char name[64];
    if (!token_for(key, name, sizeof(name))) { unknown++; continue; }
    put(name, value); assignments++;
  }
  if (!header) { snprintf(message, size, "That file has no [theme \"name\"] header."); return false; }
  if (!assignments) { snprintf(message, size, "Theme \"%s\" set nothing this desktop knows.", file.name); return false; }

  mu_Color *live = (mu_Color *)&re_theme;
  const mu_Color *baked = (const mu_Color *)&re_theme_presets[re_theme_preset];
  int applied = 0, unparsed = 0;
  for (int i = 0; i < RE_THEME_COLOR_COUNT; i++) {
    char resolved[192]; mu_Color colour;
    if (!expand(value_of(re_theme_field_tokens[i]), resolved, sizeof(resolved), 0) || !parse_color(resolved, &colour)) {
      live[i] = baked[i]; unparsed++; continue;
    }
    live[i] = colour; applied++;
  }
  char resolved[192];
  if (expand(value_of("--re-accent-hue"), resolved, sizeof(resolved), 0)) {
    char *end = NULL; float hue = strtof(resolved, &end);
    if (end != resolved) file.hue = hue;
  }
  if (unknown) snprintf(message, size, "Theme \"%s\" applied; %d key%s this desktop compiles in were left alone.",
                        file.name, unknown, unknown == 1 ? "" : "s");
  else if (unparsed) snprintf(message, size, "Theme \"%s\" applied; %d colour%s could not be read.",
                              file.name, unparsed, unparsed == 1 ? "" : "s");
  else snprintf(message, size, "Theme \"%s\" applied.", file.name);
  return applied > 0;
}

bool re_theme_file_load(const char *path, char *message, size_t size) {
  FILE *handle = fopen(path, "rb");
  if (!handle) { snprintf(message, size, "Could not open %s.", path); return false; }
  fseek(handle, 0, SEEK_END); long length = ftell(handle); fseek(handle, 0, SEEK_SET);
  if (length < 0 || length > 1 << 20) { fclose(handle); snprintf(message, size, "%s is not a theme file.", path); return false; }
  char *text = (char *)calloc((size_t)length + 1, 1);
  if (!text) { fclose(handle); snprintf(message, size, "Out of memory reading %s.", path); return false; }
  size_t read = fread(text, 1, (size_t)length, handle);
  text[read] = 0; fclose(handle);
  bool ok = re_theme_file_apply(text, message, size);
  free(text);
  return ok;
}

bool re_theme_file_save(const char *path, const char *name, char *message, size_t size) {
  FILE *handle = fopen(path, "wb");
  if (!handle) { snprintf(message, size, "Could not write %s.", path); return false; }
  const mu_Color *live = (const mu_Color *)&re_theme;
  fprintf(handle, "[theme \"%s\"]\n", name && *name ? name : "exported");
  fprintf(handle, "accent-hue = %g\n", (double)re_theme_hue());
  int written = 0;
  for (int i = 0; i < RE_THEME_COLOR_COUNT; i++) {
    const char *token = re_theme_field_tokens[i];
    bool seen = false;
    for (int j = 0; j < i; j++) if (!strcmp(re_theme_field_tokens[j], token)) { seen = true; break; }
    if (seen) continue;
    if (live[i].a == 255) fprintf(handle, "%s = #%02x%02x%02x\n", token + 2, live[i].r, live[i].g, live[i].b);
    else fprintf(handle, "%s = #%02x%02x%02x%02x\n", token + 2, live[i].r, live[i].g, live[i].b, live[i].a);
    written++;
  }
  fclose(handle);
  snprintf(message, size, "Wrote %d colours to %s.", written, path);
  return true;
}

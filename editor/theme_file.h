/* Theme files: the card's `[theme "name"]` key/value format, over the live preset (charter D34).
 *
 * A file may set any token in any of the three layers. Resolution happens against the generated
 * token graph in theme.c, so overriding a palette entry moves every semantic and view token that
 * reads it, exactly as the stylesheet does. Metrics and fonts are compiled in and are reported as
 * unapplied rather than silently dropped; only colours and the accent hue reach the live theme.
 */
#ifndef RENGINE_THEME_FILE_H
#define RENGINE_THEME_FILE_H
#include <stdbool.h>
#include <stddef.h>

/* Applies theme-file text over the current preset. `message` always receives a sentence describing
 * what happened, whether or not the file applied. Returns false when the text is not a theme file. */
bool re_theme_file_apply(const char *text, char *message, size_t size);

/* Reads and applies a file. Returns false when it cannot be read or is not a theme file. */
bool re_theme_file_load(const char *path, char *message, size_t size);

/* Writes the live theme as a theme file under `name`. */
bool re_theme_file_save(const char *path, const char *name, char *message, size_t size);

/* The accent hue the last applied file carried, or a negative number when it carried none. */
float re_theme_file_hue(void);

/* The name from the last applied file, or an empty string. */
const char *re_theme_file_name(void);

#endif

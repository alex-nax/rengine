#ifndef RENGINE_FILELINK_H
#define RENGINE_FILELINK_H
#include <stdbool.h>
#include <stddef.h>
bool re_file_reference(const char *text, size_t at, char *target, size_t capacity);
bool re_file_target(const char *target, const char *root, char *relative, size_t capacity, int *line, int *column);
#endif

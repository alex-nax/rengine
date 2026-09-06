/* UTF-8 helpers shared by views and adapters. */
#ifndef RENGINE_UTF8_H
#define RENGINE_UTF8_H
#include <stdint.h>
uint32_t re_utf8(const char **text);
int re_encode(uint32_t codepoint, char bytes[5]);
#endif

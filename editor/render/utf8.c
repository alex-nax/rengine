#include "render/utf8.h"

uint32_t re_utf8(const char **text) {
  const unsigned char *s = (const unsigned char *)*text;
  if (!*s) return 0;
  uint32_t c = *s++; int count = 0;
  if (c >= 0xc2 && c < 0xe0) { c &= 31; count = 1; }
  else if (c >= 0xe0 && c < 0xf0) { c &= 15; count = 2; }
  else if (c >= 0xf0 && c < 0xf5) { c &= 7; count = 3; }
  else if (c >= 128) { *text = (const char *)s; return 0xfffd; }
  int bytes = count;
  while (count--) {
    if ((*s & 0xc0) != 0x80) { *text = (const char *)s; return 0xfffd; }
    c = (c << 6) | (*s++ & 63);
  }
  *text = (const char *)s;
  if ((bytes == 1 && c < 128) || (bytes == 2 && c < 2048) ||
      (bytes == 3 && c < 65536) || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) return 0xfffd;
  return c;
}

int re_encode(uint32_t c, char b[5]) {
  int n;
  if (c < 128) { b[0] = (char)c; n = 1; }
  else if (c < 2048) { b[0] = (char)(0xc0 | (c >> 6)); b[1] = (char)(0x80 | (c & 63)); n = 2; }
  else if (c < 65536) { b[0] = (char)(0xe0 | (c >> 12)); b[1] = (char)(0x80 | ((c >> 6) & 63)); b[2] = (char)(0x80 | (c & 63)); n = 3; }
  else { b[0] = (char)(0xf0 | (c >> 18)); b[1] = (char)(0x80 | ((c >> 12) & 63)); b[2] = (char)(0x80 | ((c >> 6) & 63)); b[3] = (char)(0x80 | (c & 63)); n = 4; }
  b[n] = 0; return n;
}

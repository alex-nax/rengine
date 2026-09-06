#include "jpeg.h"
#include <stdlib.h>
#include <string.h>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#include "stb_image_write.h"

typedef struct { unsigned char *bytes; size_t size, capacity; bool failed; } Sink;

static void collect(void *context, void *data, int size) {
  Sink *sink = context;
  if (sink->failed || size < 0) return;
  if (sink->size + (size_t)size > sink->capacity) {
    size_t capacity = sink->capacity ? sink->capacity * 2 : 16384;
    while (capacity < sink->size + (size_t)size) capacity *= 2;
    unsigned char *grown = realloc(sink->bytes, capacity);
    if (!grown) { sink->failed = true; return; }
    sink->bytes = grown; sink->capacity = capacity;
  }
  memcpy(sink->bytes + sink->size, data, (size_t)size);
  sink->size += (size_t)size;
}

bool re_jpeg_encode(const unsigned char *rgb, int width, int height, int quality, unsigned char **out, size_t *size) {
  Sink sink = {NULL, 0, 0, false};
  if (!rgb || width < 1 || height < 1 || !out || !size) return false;
  if (!stbi_write_jpg_to_func(collect, &sink, width, height, 3, rgb, quality) || sink.failed || !sink.size) {
    free(sink.bytes); return false;
  }
  *out = sink.bytes; *size = sink.size; return true;
}

#include "imageview.h"
#include <assert.h>

int main(int argc, char **argv) {
  assert(argc == 2); ReImageView *view = re_image_open(); assert(view);
  const char *names[] = {"image.png", "image.jpg", "image.gif"};
  unsigned char bytes[8192]; char path[2048], error[512];
  for (int i = 0; i < 3; i++) {
    snprintf(path, sizeof(path), "%s/%s", argv[1], names[i]); FILE *file = fopen(path, "rb"); assert(file);
    size_t size = fread(bytes, 1, sizeof(bytes), file); fclose(file); assert(size && size < sizeof(bytes));
    assert(re_image_load(view, bytes, size, error, sizeof(error)));
    cJSON *state = re_image_inspect(view); assert(re_number(state, "width") == 128 && re_number(state, "height") == 80); cJSON_Delete(state);
    re_image_actual(view, true); assert(re_image_is_actual(view));
    assert(!re_image_load(view, bytes, 12, error, sizeof(error)) && *error);
    state = re_image_inspect(view); assert(re_number(state, "width") == 0); cJSON_Delete(state);
  }
  assert(!re_image_load(view, bytes, 8 * 1024 * 1024 + 1, error, sizeof(error)));
  assert(!re_image_load(view, "RIFFxxxxWEBP", 12, error, sizeof(error)) && strstr(error, "WebP"));
  snprintf(path, sizeof(path), "%s/image.png", argv[1]); FILE *file = fopen(path, "rb"); assert(file);
  size_t size = fread(bytes, 1, sizeof(bytes), file); fclose(file);
  bytes[16] = bytes[20] = 0; bytes[17] = bytes[21] = 0; bytes[18] = bytes[22] = 32; bytes[19] = bytes[23] = 0;
  assert(!re_image_load(view, bytes, size, error, sizeof(error)) && strstr(error, "megapixels"));
  assert(re_image_path("PHOTO.JPEG") && re_image_path("proof.png") && !re_image_path("proof.svg"));
  re_image_close(view); puts("PNG/JPEG/GIF decoding, resource limits and failure reset passed."); return 0;
}

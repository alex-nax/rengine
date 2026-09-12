#include "render/backend.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct { ReBackend base; int counts[16]; size_t executed; } Recorder;

static float rec_density(ReBackend *b, int w) { (void)b; (void)w; return 2.0f; }
static bool rec_begin(ReBackend *b, const ReDrawList *l) { (void)b; return l->width > 0 && l->height > 0; }
static void rec_execute(ReBackend *b, const ReDrawList *l) {
  Recorder *r = (Recorder *)b;
  for (size_t i = 0; i < l->count; i++) { r->counts[l->commands[i].type]++; r->executed++; }
}
static void rec_present(ReBackend *b) { (void)b; }
static bool rec_snapshot(ReBackend *b, const char *p) { (void)b; (void)p; return true; }
static ReTexture *rec_texture_create(ReBackend *b, int w, int h) { (void)b; (void)w; (void)h; return NULL; }
static ReTexture *rec_texture_adopt(ReBackend *b, uint32_t id, int w, int h) { (void)b; (void)id; (void)w; (void)h; return NULL; }
static bool rec_texture_update(ReTexture *t, const void *rgba, int pitch) { (void)t; (void)rgba; (void)pitch; return false; }
static void rec_texture_destroy(ReTexture *t) { (void)t; }
static void rec_close(ReBackend *b) { (void)b; }
static const ReBackendOps recorder_ops = {"recorder", rec_density, rec_begin, rec_execute, rec_present, rec_snapshot,
                                          rec_texture_create, rec_texture_adopt, rec_texture_update, rec_texture_destroy, rec_close};

int main(void) {
  ReDrawList list; re_draw_list_init(&list);
  re_draw_list_reset(&list, 640, 480, 2.0f, re_color(1, 2, 3, 255));
  assert(list.count == 0 && list.width == 640 && list.height == 480 && list.density == 2.0f && list.clear.b == 3);

  ReRect clip = re_rect(10, 20, 30, 40);
  char buffer[8]; strcpy(buffer, "héllo");
  assert(re_draw_list_clip(&list, &clip));
  assert(re_draw_list_rect(&list, re_rect(1, 2, 3, 4), re_color(9, 8, 7, 6)));
  assert(re_draw_list_text(&list, RE_FACE_UI, 12, 5, 6, re_color(1, 1, 1, 1), buffer, -1));
  strcpy(buffer, "xxxxxx");
  assert(re_draw_list_rrect(&list, re_rect(0, 0, 10, 10), re_color(0, 0, 0, 255), 3.0f, RE_CORNER_TOP_LEFT | RE_CORNER_TOP_RIGHT));
  assert(re_draw_list_frame(&list, re_rect(0, 0, 10, 10), re_color(1, 1, 1, 255), re_color(255, 255, 255, 13), 3.0f));
  assert(re_draw_list_shadow(&list, re_rect(0, 0, 10, 10), re_color(0, 0, 0, 128), 6.0f, 4));
  assert(re_draw_list_ring(&list, re_rect(0, 0, 10, 10), re_color(2, 2, 2, 255), 3.0f, 2));
  assert(re_draw_list_icon(&list, RE_ICON_CLOSE, 16, re_rect(0, 0, 22, 26), re_color(3, 3, 3, 255)));
  ReTexture fake = {NULL, 4, 4};
  assert(re_draw_list_texture(&list, &fake, re_rect(7, 7, 4, 4), RE_DRAW_FLIP_Y));
  assert(re_draw_list_texture(&list, NULL, re_rect(0, 0, 1, 1), 0) && list.count == 9);
  assert(re_draw_list_gradient(&list, re_rect(0, 0, 20, 8), re_color(10, 20, 30, 255), re_color(210, 220, 230, 128),
                               4.0f, RE_CORNERS_ALL, RE_GRADIENT_VERTICAL) && list.count == 10);
  assert(re_draw_list_clip(&list, NULL) && list.count == 11);

  const ReCommand *c = list.commands;
  assert(c[0].type == RE_CMD_CLIP && c[0].rect.w == 30 && !(c[0].flags & RE_CLIP_RESET));
  assert(c[1].type == RE_CMD_RECT && c[1].color.r == 9 && c[1].rect.h == 4);
  assert(c[2].type == RE_CMD_TEXT && c[2].face == RE_FACE_UI && c[2].size == 12 && c[2].rect.x == 5 && c[2].text_length == 6);
  assert(strcmp(re_draw_list_string(&list, &c[2]), "héllo") == 0);
  assert(c[3].type == RE_CMD_RRECT && c[3].corners == (RE_CORNER_TOP_LEFT | RE_CORNER_TOP_RIGHT) && c[3].radius == 3.0f);
  assert(c[4].type == RE_CMD_FRAME && c[4].secondary.a == 13);
  assert(c[5].type == RE_CMD_SHADOW && c[5].width == 4);
  assert(c[6].type == RE_CMD_RING && c[6].width == 2);
  assert(c[7].type == RE_CMD_ICON && c[7].icon == RE_ICON_CLOSE && c[7].size == 16);
  assert(c[8].type == RE_CMD_TEXTURE && c[8].texture == &fake && (c[8].flags & RE_DRAW_FLIP_Y));
  assert(c[9].type == RE_CMD_GRADIENT && c[9].color.r == 10 && c[9].secondary.a == 128);
  assert(c[9].radius == 4.0f && c[9].corners == RE_CORNERS_ALL && c[9].flags == RE_GRADIENT_VERTICAL);
  assert(c[10].type == RE_CMD_CLIP && (c[10].flags & RE_CLIP_RESET));

  /* Every adapter steps a ramp through this sampler, so the stops are part of the contract. */
  ReColor from = re_color(0, 0, 0, 255), to = re_color(100, 200, 40, 55);
  assert(re_gradient_sample(from, to, 0, 8).r == 0 && re_gradient_sample(from, to, 7, 8).r == 100);
  assert(re_gradient_sample(from, to, 7, 8).a == 55 && re_gradient_sample(from, to, 0, 8).a == 255);
  assert(re_gradient_sample(from, to, -3, 8).g == 0 && re_gradient_sample(from, to, 99, 8).g == 200);
  assert(re_gradient_sample(from, to, 0, 1).b == 0 && re_gradient_sample(from, to, 0, 0).b == 0);
  ReColor middle = re_gradient_sample(from, to, 4, 9);
  assert(middle.r == 50 && middle.g == 100 && middle.b == 20);
  assert(strcmp(re_draw_list_string(&list, &c[1]), "") == 0);

  Recorder recorder; memset(&recorder, 0, sizeof(recorder)); recorder.base.ops = &recorder_ops;
  assert(recorder.base.ops->begin(&recorder.base, &list));
  recorder.base.ops->execute(&recorder.base, &list);
  assert(recorder.executed == 11 && recorder.counts[RE_CMD_GRADIENT] == 1 && recorder.counts[RE_CMD_CLIP] == 2 && recorder.counts[RE_CMD_TEXT] == 1 && recorder.counts[RE_CMD_TEXTURE] == 1);
  assert(recorder.base.ops->density(&recorder.base, 100) == 2.0f);

  size_t capacity = list.capacity;
  re_draw_list_reset(&list, 8, 8, 1.0f, re_color(0, 0, 0, 0));
  assert(list.count == 0 && list.string_size == 0 && !list.overflow && list.capacity == capacity);

  re_draw_list_limits(&list, 3, 8);
  assert(re_draw_list_rect(&list, re_rect(0, 0, 1, 1), re_color(0, 0, 0, 0)));
  assert(re_draw_list_text(&list, RE_FACE_MONO, 16, 0, 0, re_color(0, 0, 0, 0), "abcdefg", -1));
  assert(!re_draw_list_text(&list, RE_FACE_MONO, 16, 0, 0, re_color(0, 0, 0, 0), "h", -1) && list.overflow && list.count == 2);
  assert(!re_draw_list_rect(&list, re_rect(0, 0, 1, 1), re_color(0, 0, 0, 0)) && list.count == 2);
  re_draw_list_reset(&list, 8, 8, 1.0f, re_color(0, 0, 0, 0));
  assert(!list.overflow);
  assert(re_draw_list_rect(&list, re_rect(0, 0, 1, 1), re_color(0, 0, 0, 0)) && re_draw_list_rect(&list, re_rect(0, 0, 1, 1), re_color(0, 0, 0, 0)) && re_draw_list_rect(&list, re_rect(0, 0, 1, 1), re_color(0, 0, 0, 0)));
  assert(!re_draw_list_rect(&list, re_rect(0, 0, 1, 1), re_color(0, 0, 0, 0)) && list.overflow && list.count == 3);

  re_draw_list_free(&list);
  assert(list.commands == NULL && list.strings == NULL);
  printf("draw list contract v%d: order, arena copies, clip reset, recorder adapter and overflow checks passed\n", RE_DRAW_LIST_VERSION);
  return 0;
}

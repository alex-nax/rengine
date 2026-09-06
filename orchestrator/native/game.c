#include "game.h"

static bool send(ReGame *g, int kind, const int *values, int count) {
  cJSON *j = cJSON_CreateObject(); cJSON_AddNumberToObject(j, "kind", kind);
  cJSON_AddItemToObject(j, "values", cJSON_CreateIntArray(values, count));
  char *text = cJSON_PrintUnformatted(j); bool ok = text && re_socket_send(g->socket, text);
  free(text); cJSON_Delete(j); return ok;
}
static void focus(ReGame *g) { if (!g->focused) g->focused = send(g, 5, (int[]){1}, 1); }
ReGame *re_game_open(ReNet *net, const char *id) {
  ReGame *g = calloc(1, sizeof(*g)); if (!g) return NULL;
  char route[128]; snprintf(route, sizeof(route), "surface?id=%s", id); g->socket = re_socket_open(net, route);
  re_copy(g->status, sizeof(g->status), "Connecting to game"); return g;
}
/* Freeing the pointer alone. The full release also tells the game to drop every held key and forgets
 * that the pane has focus, which is right when the workspace takes the pane away and wrong when the
 * player is still in the game with a menu open — see sidecar: escape-forwards */
static void uncapture(ReGame *g) {
  if (g->captured) SDL_SetRelativeMouseMode(SDL_FALSE);
  g->captured = false; SDL_CaptureMouse(SDL_FALSE);
}
void re_game_release(ReGame *g) {
  if (!g) return;
  send(g, 6, NULL, 0); g->focused = false; g->buttons = 0;
  uncapture(g);
}
void re_game_capture(ReGame *g) {
  if (SDL_SetRelativeMouseMode(SDL_TRUE) != 0) { re_copy(g->status, sizeof(g->status), SDL_GetError()); return; }
  g->captured = true; focus(g);
}
void re_game_close(ReGame *g) {
  if (!g) return;
  re_game_release(g); re_socket_close(g->socket); re_draw_texture_destroy(g->texture); free(g);
}
void re_game_tick(ReGame *g, ReDraw *draw) {
  ReMessage *m;
  while ((m = re_socket_poll(g->socket))) {
    cJSON *j = cJSON_ParseWithLength(m->data, m->size);
    const char *type = re_string(j, "type"), *status = re_string(j, "error");
    if (!*status) status = re_string(j, "status");
    if (*status) re_copy(g->status, sizeof(g->status), status);
    if (!strcmp(type, "disconnected")) { re_game_release(g); re_copy(g->status, sizeof(g->status), "Game surface disconnected"); }
    cJSON_Delete(j); re_message_free(m);
  }
  m = re_socket_frame(g->socket); if (!m) return;
  uint32_t header[6] = {0};
  if (m->size >= sizeof(header)) { memcpy(header, m->data, sizeof(header)); for (int i = 0; i < 6; i++) header[i] = SDL_SwapLE32(header[i]); }
  int w = (int)header[1], h = (int)header[2];
  if (header[0] != 0x31464752 || w < 1 || w > 1920 || h < 1 || h > 1080 || header[5] || header[4] != (uint32_t)(w * h * 4) || m->size != 24 + (size_t)header[4]) {
    re_copy(g->status, sizeof(g->status), "Rejected invalid game frame"); re_message_free(m); return;
  }
  if (g->sink) g->sink(g->sink_user, (const unsigned char *)m->data + 24, w, h, (int)header[3]);
  if (!g->texture || w != g->width || h != g->height) {
    re_draw_texture_destroy(g->texture);
    g->texture = re_draw_texture_create(draw, w, h);
  }
  if (re_draw_texture_update(g->texture, m->data + 24, w * 4)) {
    g->width = w; g->height = h; g->sequence = (int)header[3]; re_copy(g->status, sizeof(g->status), "Live");
  }
  re_message_free(m);
}
void re_game_sink(ReGame *g, ReGameFrame sink, void *user) { if (g) { g->sink = sink; g->sink_user = user; } }
void re_game_draw(ReGame *g, ReDraw *draw, mu_Rect r) {
  re_draw_rect(draw, r, RE_COLOR_GAME_BACKDROP); if (!g->texture || r.w < 1 || r.h < 1) return;
  double scale = (double)r.w / g->width;
  if (g->height * scale > r.h) scale = (double)r.h / g->height;
  int w = (int)(g->width * scale), h = (int)(g->height * scale);
  g->rect = mu_rect(r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
  re_draw_texture(draw, g->texture, g->rect, RE_DRAW_FLIP_Y);
}
void re_game_event(ReGame *g, const SDL_Event *e) {
  if (e->type == SDL_KEYDOWN || e->type == SDL_KEYUP) {
    /* Escape opens the menu in most games, and a menu needs a cursor, so it frees the pointer and
     * still reaches the game. Keeping focus across that means no menu re-announces it. */
    if (e->type == SDL_KEYDOWN && e->key.keysym.sym == SDLK_ESCAPE && g->captured) uncapture(g);
    if (e->type == SDL_KEYDOWN) focus(g);
    send(g, 1, (int[]){e->key.keysym.scancode, e->type == SDL_KEYDOWN, e->key.repeat != 0}, 3);
  } else if (e->type == SDL_MOUSEMOTION) {
    int x = (e->motion.x - g->rect.x) * g->width / re_max(1, g->rect.w);
    int y = (e->motion.y - g->rect.y) * g->height / re_max(1, g->rect.h);
    send(g, 2, (int[]){re_max(-32768, re_min(x, 32767)), re_max(-32768, re_min(y, 32767)),
      re_max(-32768, re_min(e->motion.xrel, 32767)), re_max(-32768, re_min(e->motion.yrel, 32767))}, 4);
  } else if (e->type == SDL_MOUSEBUTTONDOWN || e->type == SDL_MOUSEBUTTONUP) {
    if (e->button.button > 5) return;
    bool down = e->type == SDL_MOUSEBUTTONDOWN;
    if (!down && !(g->buttons & SDL_BUTTON(e->button.button))) return;
    if (down) { focus(g); g->buttons |= SDL_BUTTON(e->button.button); SDL_CaptureMouse(SDL_TRUE); }
    else { g->buttons &= ~SDL_BUTTON(e->button.button); if (!g->buttons) SDL_CaptureMouse(SDL_FALSE); }
    int x = (e->button.x - g->rect.x) * g->width / re_max(1, g->rect.w);
    int y = (e->button.y - g->rect.y) * g->height / re_max(1, g->rect.h);
    send(g, 3, (int[]){e->button.button, down, re_max(-32768, re_min(x, 32767)), re_max(-32768, re_min(y, 32767))}, 4);
  } else if (e->type == SDL_MOUSEWHEEL) send(g, 4, (int[]){re_max(-1000, re_min(e->wheel.x, 1000)), re_max(-1000, re_min(e->wheel.y, 1000))}, 2);
}

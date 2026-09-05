#include "net.h"
#include <curl/curl.h>

#define RE_NET_BYTES (16 * 1024 * 1024)
#define RE_NET_QUEUE 128
typedef struct { ReMessage *first, *last; int count; size_t bytes; } Queue;
struct ReNet {
  char url[128], token[65];
  SDL_mutex *mutex; SDL_cond *ready; SDL_Thread *thread; SDL_atomic_t stop;
  Queue requests, responses; int serial;
};
struct ReSocket {
  char url[512];
  SDL_mutex *mutex; SDL_cond *space; SDL_Thread *thread; SDL_atomic_t stop, connected;
  Queue outgoing, incoming; ReMessage *frame;
};
static bool push(Queue *q, ReMessage *m) {
  if (q->count >= RE_NET_QUEUE || m->size > RE_NET_BYTES - q->bytes) return false;
  m->next = NULL;
  if (q->last) q->last->next = m; else q->first = m;
  q->last = m; q->count++; q->bytes += m->size; return true;
}
static ReMessage *pop(Queue *q) {
  ReMessage *m = q->first;
  if (m) { q->first = m->next; if (!q->first) q->last = NULL; q->count--; q->bytes -= m->size; m->next = NULL; }
  return m;
}
void re_message_free(ReMessage *m) { if (m) { free(m->data); free(m); } }
static void clear(Queue *q) { ReMessage *m; while ((m = pop(q))) re_message_free(m); }
static void wake(void) { SDL_Event event = {.type = SDL_USEREVENT}; SDL_PushEvent(&event); }
static ReMessage *message(const char *text, size_t size) {
  ReMessage *m = calloc(1, sizeof(*m)); if (!m) return NULL;
  m->data = malloc(size + 1); if (!m->data) { free(m); return NULL; }
  if (size) memcpy(m->data, text, size); m->data[size] = 0; m->size = size; return m;
}
static size_t receive(char *bytes, size_t size, size_t count, void *userdata) {
  ReMessage *m = userdata;
  if (count && size > RE_NET_BYTES / count) return 0;
  size_t length = size * count;
  if (length > RE_NET_BYTES - m->size) return 0;
  char *next = realloc(m->data, m->size + length + 1);
  if (!next) return 0;
  m->data = next; memcpy(m->data + m->size, bytes, length); m->size += length; m->data[m->size] = 0;
  return length;
}
static void configure(CURL *curl) {
  curl_easy_setopt(curl, CURLOPT_PROXY, "");
  curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "http,ws");
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 1000L);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 5000L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
}
static int http_worker(void *userdata) {
  ReNet *n = userdata; CURL *curl = curl_easy_init();
  while (!SDL_AtomicGet(&n->stop)) {
    SDL_LockMutex(n->mutex);
    while (!n->requests.first && !SDL_AtomicGet(&n->stop)) SDL_CondWait(n->ready, n->mutex);
    ReMessage *request = pop(&n->requests); SDL_UnlockMutex(n->mutex);
    if (!request) continue;
    ReMessage *response = message("", 0);
    if (!response) { re_message_free(request); break; }
    response->id = request->id;
    const char *route = request->data, *body = route + strlen(route) + 1;
    char url[4096], auth[96];
    snprintf(url, sizeof(url), "%s/api/%s", n->url, route);
    snprintf(auth, sizeof(auth), "Authorization: Bearer %s", n->token);
    curl_easy_reset(curl); configure(curl);
    struct curl_slist *headers = curl_slist_append(NULL, auth);
    headers = curl_slist_append(headers, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_URL, url); curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive); curl_easy_setopt(curl, CURLOPT_WRITEDATA, response);
    if (request->status) curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    CURLcode code = curl_easy_perform(curl); long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status); response->status = (int)status;
    if (code != CURLE_OK) {
      free(response->data); response->data = strdup(curl_easy_strerror(code)); response->size = strlen(response->data); response->status = 0;
    }
    curl_slist_free_all(headers); re_message_free(request);
    SDL_LockMutex(n->mutex);
    while (!push(&n->responses, response) && !SDL_AtomicGet(&n->stop)) SDL_CondWait(n->ready, n->mutex);
    if (SDL_AtomicGet(&n->stop) && n->responses.last != response) re_message_free(response);
    SDL_UnlockMutex(n->mutex); wake();
  }
  curl_easy_cleanup(curl); return 0;
}
ReNet *re_net_open(const char *url, const char *token) {
  if (!url || !token || strlen(token) != 64 || strspn(token, "0123456789abcdef") != 64 || strncmp(url, "http://127.0.0.1:", 17)) return NULL;
  char *end; long port = strtol(url + 17, &end, 10);
  if (*end || port < 1 || port > 65535 || curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) return NULL;
  ReNet *n = calloc(1, sizeof(*n)); if (!n) return NULL;
  re_copy(n->url, sizeof(n->url), url); re_copy(n->token, sizeof(n->token), token);
  n->mutex = SDL_CreateMutex(); n->ready = SDL_CreateCond(); n->thread = SDL_CreateThread(http_worker, "workspace-http", n);
  if (!n->thread) { SDL_DestroyMutex(n->mutex); SDL_DestroyCond(n->ready); free(n); return NULL; }
  return n;
}
void re_net_close(ReNet *n) {
  if (!n) return;
  SDL_AtomicSet(&n->stop, 1); SDL_LockMutex(n->mutex); SDL_CondBroadcast(n->ready); SDL_UnlockMutex(n->mutex);
  SDL_WaitThread(n->thread, NULL); clear(&n->requests); clear(&n->responses);
  SDL_DestroyMutex(n->mutex); SDL_DestroyCond(n->ready); free(n); curl_global_cleanup();
}
int re_net_request(ReNet *n, const char *route, const cJSON *body) {
  if (!n || strlen(route) > 3500) return 0;
  char *text = body ? cJSON_PrintUnformatted(body) : strdup(""); if (!text) return 0;
  size_t a = strlen(route) + 1, b = strlen(text) + 1;
  ReMessage *r = message("", 0); if (!r) { free(text); return 0; }
  free(r->data); r->data = malloc(a + b); r->size = a + b;
  if (!r->data) { free(r); free(text); return 0; }
  memcpy(r->data, route, a); memcpy(r->data + a, text, b); free(text); r->status = body != NULL;
  SDL_LockMutex(n->mutex); r->id = ++n->serial; int id = r->id;
  if (!push(&n->requests, r)) { re_message_free(r); id = 0; }
  SDL_CondSignal(n->ready); SDL_UnlockMutex(n->mutex); return id;
}
ReMessage *re_net_poll(ReNet *n) {
  if (!n) return NULL;
  SDL_LockMutex(n->mutex); ReMessage *m = pop(&n->responses); SDL_CondSignal(n->ready); SDL_UnlockMutex(n->mutex); return m;
}
char *re_net_query(const char *route, const char *root, const char *path) {
  char *r = curl_easy_escape(NULL, root, 0), *p = curl_easy_escape(NULL, path, 0);
  size_t size = strlen(route) + strlen(r) + strlen(p) + 32; char *result = malloc(size);
  if (result) snprintf(result, size, "%s?rootId=%s&path=%s", route, r, p);
  curl_free(r); curl_free(p); return result;
}
static bool socket_received(ReSocket *s, ReMessage *m, bool binary) {
  if (!m) return false;
  SDL_LockMutex(s->mutex); bool ok = true;
  if (binary) { re_message_free(s->frame); s->frame = m; }
  else {
    while (!(ok = push(&s->incoming, m)) && !SDL_AtomicGet(&s->stop)) {
      wake(); SDL_CondWaitTimeout(s->space, s->mutex, 50);
    }
  }
  SDL_UnlockMutex(s->mutex); if (!ok) re_message_free(m); wake(); return ok;
}
static void socket_stream(ReSocket *s, CURL *curl) {
  CURLcode code;
  ReMessage *incoming = message("", 0), *outgoing = NULL; size_t sent = 0; bool binary = false;
  while (incoming && !SDL_AtomicGet(&s->stop)) {
    if (!outgoing) { SDL_LockMutex(s->mutex); outgoing = pop(&s->outgoing); SDL_UnlockMutex(s->mutex); sent = 0; }
    if (outgoing) {
      size_t amount = 0;
      code = curl_ws_send(curl, outgoing->data + sent, outgoing->size - sent, &amount,
                          sent ? 0 : (curl_off_t)outgoing->size, CURLWS_TEXT | CURLWS_OFFSET);
      sent += amount;
      if (code != CURLE_OK && code != CURLE_AGAIN) break;
      if (sent == outgoing->size) { re_message_free(outgoing); outgoing = NULL; }
    }
    char buffer[65536]; size_t count = 0; const struct curl_ws_frame *meta = NULL;
    code = curl_ws_recv(curl, buffer, sizeof(buffer), &count, &meta);
    if (code == CURLE_AGAIN) { SDL_Delay(5); continue; }
    if (code != CURLE_OK || (meta->flags & CURLWS_CLOSE)) break;
    if (!(meta->flags & (CURLWS_TEXT | CURLWS_BINARY | CURLWS_CONT))) continue;
    if (meta->flags & CURLWS_BINARY) binary = true;
    if (receive(buffer, 1, count, incoming) != count) break;
    if (!meta->bytesleft && !(meta->flags & CURLWS_CONT)) {
      if (!socket_received(s, incoming, binary)) { incoming = NULL; break; }
      incoming = message("", 0); binary = false;
      if (!incoming) break;
    }
  }
  re_message_free(incoming); re_message_free(outgoing);
}
static int socket_worker(void *userdata) {
  ReSocket *s = userdata;
  while (!SDL_AtomicGet(&s->stop)) {
    CURL *curl = curl_easy_init();
    if (curl) {
      configure(curl); curl_easy_setopt(curl, CURLOPT_URL, s->url); curl_easy_setopt(curl, CURLOPT_CONNECT_ONLY, 2L);
      if (curl_easy_perform(curl) == CURLE_OK && !SDL_AtomicGet(&s->stop)) {
        SDL_AtomicSet(&s->connected, 1);
        socket_received(s, message("{\"type\":\"connected\"}", 20), false); socket_stream(s, curl);
      }
    }
    SDL_LockMutex(s->mutex); SDL_AtomicSet(&s->connected, 0); clear(&s->outgoing); SDL_UnlockMutex(s->mutex);
    if (curl) curl_easy_cleanup(curl);
    if (SDL_AtomicGet(&s->stop)) break;
    socket_received(s, message("{\"type\":\"disconnected\"}", 23), false);
    for (int i = 0; i < 50 && !SDL_AtomicGet(&s->stop); i++) SDL_Delay(10);
  }
  return 0;
}
ReSocket *re_socket_open(ReNet *n, const char *route) {
  if (!n || strlen(route) > 256) return NULL;
  ReSocket *s = calloc(1, sizeof(*s)); if (!s) return NULL;
  snprintf(s->url, sizeof(s->url), "ws%s/%s%ctoken=%s", n->url + 4, route, strchr(route, '?') ? '&' : '?', n->token);
  s->mutex = SDL_CreateMutex(); s->space = SDL_CreateCond(); s->thread = SDL_CreateThread(socket_worker, "workspace-stream", s);
  if (!s->thread) { SDL_DestroyCond(s->space); SDL_DestroyMutex(s->mutex); free(s); return NULL; } return s;
}
bool re_socket_send(ReSocket *s, const char *text) {
  if (!s) return false;
  ReMessage *m = message(text, strlen(text)); if (!m) return false;
  SDL_LockMutex(s->mutex); bool ok = SDL_AtomicGet(&s->connected) && push(&s->outgoing, m); SDL_UnlockMutex(s->mutex);
  if (!ok) re_message_free(m); return ok;
}
ReMessage *re_socket_poll(ReSocket *s) {
  if (!s) return NULL;
  SDL_LockMutex(s->mutex); ReMessage *m = pop(&s->incoming); SDL_CondSignal(s->space); SDL_UnlockMutex(s->mutex); return m;
}
ReMessage *re_socket_frame(ReSocket *s) {
  if (!s) return NULL;
  SDL_LockMutex(s->mutex); ReMessage *m = s->frame; s->frame = NULL; SDL_UnlockMutex(s->mutex); return m;
}
void re_socket_close(ReSocket *s) {
  if (!s) return;
  SDL_AtomicSet(&s->stop, 1); SDL_LockMutex(s->mutex); SDL_CondBroadcast(s->space); SDL_UnlockMutex(s->mutex);
  SDL_WaitThread(s->thread, NULL); clear(&s->outgoing); clear(&s->incoming);
  re_message_free(s->frame); SDL_DestroyCond(s->space); SDL_DestroyMutex(s->mutex); free(s);
}

#ifndef RENGINE_NET_H
#define RENGINE_NET_H
#include "common.h"
typedef struct ReNet ReNet;
typedef struct ReSocket ReSocket;
typedef struct ReMessage {
  int id, status;
  size_t size;
  char *data;
  struct ReMessage *next;
} ReMessage;
ReNet *re_net_open(const char *url, const char *token);
void re_net_close(ReNet *net);
int re_net_request(ReNet *net, const char *route, const cJSON *body);
ReMessage *re_net_poll(ReNet *net);
void re_message_free(ReMessage *message);
char *re_net_query(const char *route, const char *root, const char *path);
ReSocket *re_socket_open(ReNet *net, const char *route);
bool re_socket_send(ReSocket *socket, const char *text);
bool re_socket_pending(ReSocket *socket);
ReMessage *re_socket_poll(ReSocket *socket);
ReMessage *re_socket_frame(ReSocket *socket);
void re_socket_close(ReSocket *socket);
#endif

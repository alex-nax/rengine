#include "common.h"
#ifdef _WIN32
#include <process.h>
#else
#include <sys/wait.h>
#include <unistd.h>
#include <errno.h>
#endif

#ifdef _WIN32
/* The CRT joins _spawnv arguments with spaces and never quotes them, so "C:\Program Files\nodejs\node.exe" would reach the child as two words. */
static const char *quoted(const char *arg, char *buffer, size_t size) {
  if (!strchr(arg, ' ')) return arg;
  snprintf(buffer, size, "\"%s\"", arg);
  return buffer;
}
#endif

int re_bootstrap(const char *binary) {
#ifdef _WIN32
  char node[1024], script[1024], target[1024];
  const char *args[] = {quoted(RENGINE_NODE, node, sizeof(node)), quoted(RENGINE_BOOTSTRAP, script, sizeof(script)), "--binary", quoted(binary, target, sizeof(target)), NULL};
  intptr_t result = _spawnv(_P_WAIT, RENGINE_NODE, args);
  return result == 0 ? 0 : -1;
#else
  const char *args[] = {RENGINE_NODE, RENGINE_BOOTSTRAP, "--binary", binary, NULL};
  pid_t child = fork();
  if (child < 0) return -1;
  if (!child) { execv(RENGINE_NODE, (char *const *)args); _exit(127); }
  int status; pid_t result;
  do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
  return result > 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
#endif
}

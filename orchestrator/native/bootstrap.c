#include "common.h"
#ifdef _WIN32
#include <process.h>
#else
#include <sys/wait.h>
#include <unistd.h>
#include <errno.h>
#endif

int re_bootstrap(const char *binary) {
  const char *args[] = {RENGINE_NODE, RENGINE_BOOTSTRAP, "--binary", binary, NULL};
#ifdef _WIN32
  intptr_t result = _spawnv(_P_WAIT, RENGINE_NODE, args);
  return result == 0 ? 0 : -1;
#else
  pid_t child = fork();
  if (child < 0) return -1;
  if (!child) { execv(RENGINE_NODE, (char *const *)args); _exit(127); }
  int status; pid_t result;
  do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
  return result > 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
#endif
}

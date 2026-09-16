#include "common.h"
#ifdef _WIN32
#include <process.h>
#else
#include <sys/wait.h>
#include <unistd.h>
#include <errno.h>
#endif

/* The desktop's layered bootstrap: make sure an update supervisor is serving this workspace before
 * the window draws anything (F163, spec 146).
 *
 * This was `node orchestrator/runtime/bootstrap.mjs`, and it was the LAST thing the native binary
 * needed an interpreter for. It is now `red-launch bootstrap`, so the desktop build requires no
 * node and bakes no path to one.
 *
 * The binary is resolved the way every other component here resolves a sibling: an explicit
 * environment variable first, then release, then debug under the checkout this was built from. A
 * baked absolute path would name one profile and be wrong for the other, and this is reached with
 * execv, which does not search PATH — spec 145 records what that cost when the value was the bare
 * word `node`: the child exited 127 having printed nothing, and the window opened with no
 * supervisor behind it.
 */

#ifdef _WIN32
#define RE_LAUNCH_NAME "red-launch.exe"
/* The CRT joins _spawnv arguments with spaces and never quotes them, so "C:\Program Files\..." would reach the child as two words. */
static const char *quoted(const char *arg, char *buffer, size_t size) {
  if (!strchr(arg, ' ')) return arg;
  snprintf(buffer, size, "\"%s\"", arg);
  return buffer;
}
#else
#define RE_LAUNCH_NAME "red-launch"
#endif

/* Answers the launcher to run, or NULL when this checkout has none built. */
static const char *launcher(char *buffer, size_t size) {
  const char *declared = getenv("RENGINE_RED_LAUNCH");
  if (declared && *declared) {
    snprintf(buffer, size, "%s", declared);
    return buffer;
  }
  static const char *const profiles[] = {"release", "debug"};
  for (size_t i = 0; i < sizeof(profiles) / sizeof(profiles[0]); i++) {
    snprintf(buffer, size, "%s/red/target/%s/" RE_LAUNCH_NAME, RENGINE_CHECKOUT, profiles[i]);
#ifdef _WIN32
    if (_access(buffer, 0) == 0) return buffer;
#else
    if (access(buffer, X_OK) == 0) return buffer;
#endif
  }
  return NULL;
}

int re_bootstrap(const char *binary) {
  char found[1024];
  const char *launch = launcher(found, sizeof(found));
  if (!launch) {
    fprintf(stderr, "red-launch is not built in %s; run: cargo build --manifest-path red/Cargo.toml --bins\n", RENGINE_CHECKOUT);
    return -1;
  }
#ifdef _WIN32
  char command[1024], target[1024];
  const char *args[] = {quoted(launch, command, sizeof(command)), "bootstrap", "--binary", quoted(binary, target, sizeof(target)), NULL};
  intptr_t result = _spawnv(_P_WAIT, launch, args);
  return result == 0 ? 0 : -1;
#else
  const char *args[] = {launch, "bootstrap", "--binary", binary, NULL};
  pid_t child = fork();
  if (child < 0) return -1;
  if (!child) { execv(launch, (char *const *)args); _exit(127); }
  int status; pid_t result;
  do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
  return result > 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : -1;
#endif
}

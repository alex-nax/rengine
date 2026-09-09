#include "filelink.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
  char path[2048]; int line, column;
  const char *markdown = "See [Before](</work/project/My Proof.png>) and [After](proof.png).";
  assert(re_file_reference(markdown, 7, path, sizeof(path)) && !strcmp(path, "/work/project/My Proof.png"));
  assert(re_file_reference(markdown, 47, path, sizeof(path)) && !strcmp(path, "proof.png"));
  const char *wrapped = "viewer screenshot (third_party/evidence/pv-\n  hands-viewer.png).";
  assert(re_file_reference(wrapped, 24, path, sizeof(path)) && !strcmp(path, "third_party/evidence/pv-hands-viewer.png"));
  assert(re_file_reference(wrapped, 49, path, sizeof(path)) && !strcmp(path, "third_party/evidence/pv-hands-viewer.png"));
  assert(re_file_reference("[proof](docs/pv-\n  hands.png)", 3, path, sizeof(path)) && !strcmp(path, "docs/pv-hands.png"));
  assert(re_file_reference("one.png\n  two.png", 2, path, sizeof(path)) && !strcmp(path, "one.png"));
  assert(re_file_reference("one.png\n  two.png", 12, path, sizeof(path)) && !strcmp(path, "two.png"));
  assert(re_file_reference("/work/project/src/main.c:12:3", 15, path, sizeof(path)));
  assert(re_file_target(path, "/work/project", path, sizeof(path), &line, &column));
  assert(!strcmp(path, "src/main.c") && line == 12 && column == 3);
  assert(re_file_target("file:///work/project/My%20Proof.png", "/work/project", path, sizeof(path), &line, &column));
  assert(!strcmp(path, "My Proof.png"));
  assert(re_file_target("file://localhost/work/project/a.png", "/work/project", path, sizeof(path), &line, &column));
  assert(!strcmp(path, "a.png"));
  assert(re_file_target("./src/../note.txt#L42", "/work/project", path, sizeof(path), &line, &column));
  assert(!strcmp(path, "note.txt") && line == 42 && column == 0);
  const char *bad[] = {"../outside.png", "a/../../outside.png", "/work/project-other/a.png", "/other/a.png",
    "file://remote/work/project/a.png", "https://site/a.png", "javascript:alert.png", "%2e%2e/out.png",
    "file:///work/project/x%00.png", "bad%zz.png", "bad%2.png", "bad%0a.png", "bad.png:0", "bad.png#L-1"};
  for (size_t i = 0; i < sizeof(bad) / sizeof(*bad); i++) assert(!re_file_target(bad[i], "/work/project", path, sizeof(path), &line, &column));
  assert(!re_file_reference("ordinary words", 2, path, sizeof(path)));
  assert(!re_file_target("long.png", "/work/project", path, 4, &line, &column));
  puts("File references preserve locations, decode local URLs and reject root escapes."); return 0;
}

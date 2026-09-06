#include "syntax.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

#define CAP 64
static ReSyntaxSpan sp[CAP];
static uint32_t st;

/* Every tokenisation in this file goes through here, so the ordering, containment and UTF-8
 * invariants are checked on every case rather than only where they are the point of the test. */
static int scan(int language, const char *text, int length) {
  int n = re_syntax_line(language, text, length, &st, sp, CAP), i, prev = 0;
  assert(n >= 0 && n <= CAP);
  for (i = 0; i < n; i++) {
    int start = (int)sp[i].start, end = start + (int)sp[i].length;
    assert(sp[i].kind != RE_SYNTAX_TEXT && sp[i].kind < RE_SYNTAX_COUNT);
    assert(sp[i].length > 0 && start >= prev && end <= length);
    assert(((unsigned char)text[start] & 0xc0) != 0x80);
    assert(end == length || ((unsigned char)text[end] & 0xc0) != 0x80);
    prev = end;
  }
  return n;
}
static int line(int language, const char *text) { return scan(language, text, (int)strlen(text)); }
static int at(int i, int kind, int start, int length) {
  return sp[i].kind == kind && sp[i].start == (uint32_t)start && sp[i].length == (uint32_t)length;
}

int main(void) {
  ReSyntaxSpan small[3];
  char punct[4097], embedded[] = "int a = 1;\0 x", *big;
  uint32_t again;
  int i, n;

  /* --- C family: keywords, types, calls, numbers, strings, comments, preprocessor ----------- */
  st = 0;
  assert(line(RE_LANG_C, "static int add(int a, int b) { return a + b; }") == 13);
  assert(at(0, RE_SYNTAX_KEYWORD, 0, 6) && at(1, RE_SYNTAX_TYPE, 7, 3) && at(2, RE_SYNTAX_FUNCTION, 11, 3));
  assert(at(3, RE_SYNTAX_PUNCT, 14, 1) && at(9, RE_SYNTAX_KEYWORD, 31, 6));
  assert(line(RE_LANG_C, "#include <stdio.h>") == 2);
  assert(at(0, RE_SYNTAX_PREPROC, 0, 8) && at(1, RE_SYNTAX_STRING, 9, 9));
  assert(line(RE_LANG_C, "  if (x == 0x1fu) puts(\"hi\\n\"); /* done */") == 10);
  assert(at(0, RE_SYNTAX_KEYWORD, 2, 2));      /* a keyword before '(' stays a keyword */
  assert(at(3, RE_SYNTAX_NUMBER, 11, 5) && at(5, RE_SYNTAX_FUNCTION, 18, 4));
  assert(at(7, RE_SYNTAX_STRING, 23, 6) && at(9, RE_SYNTAX_COMMENT, 32, 10));
  assert(line(RE_LANG_C, "char c = 'a'; // tail") == 5);
  assert(at(2, RE_SYNTAX_STRING, 9, 3) && at(4, RE_SYNTAX_COMMENT, 14, 7));
  assert(line(RE_LANG_C, "double d = 2.5e-3, h = 0x1p+4;") == 7);
  assert(at(2, RE_SYNTAX_NUMBER, 11, 6) && at(5, RE_SYNTAX_NUMBER, 23, 6));
  assert(line(RE_LANG_C, "NSString *s = @\"hi\"; @interface Foo") == 5);
  assert(at(2, RE_SYNTAX_STRING, 14, 5) && at(4, RE_SYNTAX_KEYWORD, 21, 10));
  assert(line(RE_LANG_C, "x = a/b; y = c*d;") == 6 && at(1, RE_SYNTAX_PUNCT, 5, 1));

  /* --- the block comment carry, across three lines ------------------------------------------ */
  st = 0;
  assert(line(RE_LANG_C, "int x = 1; /* open") == 5 && at(4, RE_SYNTAX_COMMENT, 11, 7) && st == 1);
  assert(line(RE_LANG_C, " still comment") == 1 && at(0, RE_SYNTAX_COMMENT, 0, 14) && st == 1);
  assert(line(RE_LANG_C, "") == 0 && st == 1);   /* an empty line keeps the block open */
  assert(line(RE_LANG_C, " end */ int y = 2;") == 5 && st == 0);
  assert(at(0, RE_SYNTAX_COMMENT, 0, 7) && at(1, RE_SYNTAX_TYPE, 8, 3) && at(3, RE_SYNTAX_NUMBER, 16, 1));
  assert(line(RE_LANG_C, "a /* one */ b /* two */ c") == 2);
  assert(at(0, RE_SYNTAX_COMMENT, 2, 9) && at(1, RE_SYNTAX_COMMENT, 14, 9) && st == 0);

  /* --- unterminated literals ---------------------------------------------------------------- */
  st = 0;
  assert(line(RE_LANG_C, "const char *s = \"unterminated") == 5);
  assert(at(4, RE_SYNTAX_STRING, 16, 13) && st == 0);   /* a C string does not cross the line */
  assert(line(RE_LANG_C, "\"") == 1 && at(0, RE_SYNTAX_STRING, 0, 1) && st == 0);

  /* --- Python ------------------------------------------------------------------------------- */
  st = 0;
  assert(line(RE_LANG_PYTHON, "def greet(name): # hi") == 5);
  assert(at(0, RE_SYNTAX_KEYWORD, 0, 3) && at(1, RE_SYNTAX_FUNCTION, 4, 5) && at(4, RE_SYNTAX_COMMENT, 17, 4));
  assert(line(RE_LANG_PYTHON, "@decorator.thing") == 1 && at(0, RE_SYNTAX_PREPROC, 0, 16));
  assert(line(RE_LANG_PYTHON, "x = f\"a{b}\" + 12_000 ; print(True)") == 9);
  assert(at(1, RE_SYNTAX_STRING, 4, 7) && at(3, RE_SYNTAX_NUMBER, 14, 6));
  assert(at(5, RE_SYNTAX_FUNCTION, 23, 5) && at(7, RE_SYNTAX_TYPE, 29, 4));
  assert(line(RE_LANG_PYTHON, "s = 'plain' if None else \"q\"") == 6);
  assert(at(1, RE_SYNTAX_STRING, 4, 7) && at(2, RE_SYNTAX_KEYWORD, 12, 2) && at(3, RE_SYNTAX_TYPE, 15, 4));
  assert(at(4, RE_SYNTAX_KEYWORD, 20, 4) && at(5, RE_SYNTAX_STRING, 25, 3));

  /* a triple-quoted string is the other thing the carry state holds */
  st = 0;
  assert(line(RE_LANG_PYTHON, "doc = '''start") == 2 && at(1, RE_SYNTAX_STRING, 6, 8) && st == (1u << 8));
  assert(line(RE_LANG_PYTHON, "\"\"\" is not the terminator") == 1 && st == (1u << 8));
  assert(at(0, RE_SYNTAX_STRING, 0, 25));
  assert(line(RE_LANG_PYTHON, "end''' + 1") == 3 && st == 0);
  assert(at(0, RE_SYNTAX_STRING, 0, 6) && at(2, RE_SYNTAX_NUMBER, 9, 1));
  assert(line(RE_LANG_PYTHON, "\"\"\"one line\"\"\"") == 1 && at(0, RE_SYNTAX_STRING, 0, 14) && st == 0);

  /* --- JavaScript and TypeScript ------------------------------------------------------------ */
  st = 0;
  assert(line(RE_LANG_JAVASCRIPT, "export const f = (a) => `t${a}`;") == 8);
  assert(at(0, RE_SYNTAX_KEYWORD, 0, 6) && at(1, RE_SYNTAX_KEYWORD, 7, 5) && at(6, RE_SYNTAX_STRING, 24, 7));
  assert(line(RE_LANG_JAVASCRIPT, "if (x) foo(1); // c") == 8);
  assert(at(0, RE_SYNTAX_KEYWORD, 0, 2) && at(3, RE_SYNTAX_FUNCTION, 7, 3) && at(7, RE_SYNTAX_COMMENT, 15, 4));
  assert(line(RE_LANG_JAVASCRIPT, "const n: number = 0x1f_00, ok = true;") == 9);
  assert(at(2, RE_SYNTAX_TYPE, 9, 6) && at(4, RE_SYNTAX_NUMBER, 18, 7) && at(7, RE_SYNTAX_TYPE, 32, 4));
  st = 0;
  assert(line(RE_LANG_JAVASCRIPT, "let s = `open") == 3 && at(2, RE_SYNTAX_STRING, 8, 5) && st == (3u << 8));
  assert(line(RE_LANG_JAVASCRIPT, "still inside") == 1 && at(0, RE_SYNTAX_STRING, 0, 12) && st == (3u << 8));
  assert(line(RE_LANG_JAVASCRIPT, "close` + 1;") == 4 && at(0, RE_SYNTAX_STRING, 0, 6) && st == 0);

  /* --- JSON: keys are distinct from string values ------------------------------------------- */
  st = 0;
  assert(line(RE_LANG_JSON, "  \"key\": \"value\",") == 4);
  assert(at(0, RE_SYNTAX_KEYWORD, 2, 5) && at(1, RE_SYNTAX_PUNCT, 7, 1) && at(2, RE_SYNTAX_STRING, 9, 7));
  assert(line(RE_LANG_JSON, "  \"n\" : [1.5e2, true, null]") == 9);
  assert(at(0, RE_SYNTAX_KEYWORD, 2, 3));       /* whitespace before the colon still marks a key */
  assert(at(3, RE_SYNTAX_NUMBER, 9, 5) && at(5, RE_SYNTAX_TYPE, 16, 4) && at(7, RE_SYNTAX_TYPE, 22, 4));
  assert(line(RE_LANG_JSON, "[\"a\", \"b\"]") == 5);
  assert(at(1, RE_SYNTAX_STRING, 1, 3) && at(3, RE_SYNTAX_STRING, 6, 3) && st == 0);

  /* --- Markdown ----------------------------------------------------------------------------- */
  st = 0;
  assert(line(RE_LANG_MARKDOWN, "## Heading") == 1 && at(0, RE_SYNTAX_KEYWORD, 0, 10));
  assert(line(RE_LANG_MARKDOWN, "#no-space is not a heading") == 0);
  assert(line(RE_LANG_MARKDOWN, "text `code` and [a](b.md)") == 2);
  assert(at(0, RE_SYNTAX_STRING, 5, 6) && at(1, RE_SYNTAX_STRING, 19, 6));
  assert(line(RE_LANG_MARKDOWN, "``a ` b`` tail") == 1 && at(0, RE_SYNTAX_STRING, 0, 9));
  assert(line(RE_LANG_MARKDOWN, "an ` unmatched tick") == 0);
  assert(line(RE_LANG_MARKDOWN, "- item `x`") == 2 && at(0, RE_SYNTAX_PUNCT, 0, 1) && at(1, RE_SYNTAX_STRING, 7, 3));
  assert(line(RE_LANG_MARKDOWN, "2. ordered") == 1 && at(0, RE_SYNTAX_PUNCT, 0, 2));
  assert(line(RE_LANG_MARKDOWN, "> quoted") == 1 && at(0, RE_SYNTAX_PUNCT, 0, 1));
  assert(line(RE_LANG_MARKDOWN, "---") == 1 && at(0, RE_SYNTAX_PUNCT, 0, 3));
  st = 0;
  assert(line(RE_LANG_MARKDOWN, "```c") == 1 && at(0, RE_SYNTAX_PREPROC, 0, 4) && st == (1u << 10));
  assert(line(RE_LANG_MARKDOWN, "# not a heading in a fence") == 1 && at(0, RE_SYNTAX_STRING, 0, 26));
  assert(line(RE_LANG_MARKDOWN, "~~~") == 1 && at(0, RE_SYNTAX_STRING, 0, 3) && st == (1u << 10));
  assert(line(RE_LANG_MARKDOWN, "```") == 1 && at(0, RE_SYNTAX_PREPROC, 0, 3) && st == 0);
  assert(line(RE_LANG_MARKDOWN, "~~~sh") == 1 && st == ((1u << 10) | (1u << 11)));
  assert(line(RE_LANG_MARKDOWN, "~~~") == 1 && st == 0);

  /* --- shell -------------------------------------------------------------------------------- */
  st = 0;
  assert(line(RE_LANG_SHELL, "#!/bin/bash") == 1 && at(0, RE_SYNTAX_PREPROC, 0, 11));
  assert(line(RE_LANG_SHELL, "if [ -n \"$HOME\" ]; then echo 'hi' # c") == 9);
  assert(at(0, RE_SYNTAX_KEYWORD, 0, 2) && at(3, RE_SYNTAX_STRING, 8, 7) && at(5, RE_SYNTAX_KEYWORD, 19, 4));
  assert(at(6, RE_SYNTAX_TYPE, 24, 4) && at(7, RE_SYNTAX_STRING, 29, 4) && at(8, RE_SYNTAX_COMMENT, 34, 3));
  assert(line(RE_LANG_SHELL, "x=1; fi") == 4 && at(1, RE_SYNTAX_NUMBER, 2, 1) && at(3, RE_SYNTAX_KEYWORD, 5, 2));
  assert(line(RE_LANG_SHELL, "run() { local a=b#c; }") == 7);
  assert(at(0, RE_SYNTAX_FUNCTION, 0, 3) && at(3, RE_SYNTAX_KEYWORD, 8, 5)); /* '#' inside a word is not a comment */

  /* --- CMake -------------------------------------------------------------------------------- */
  st = 0;
  assert(line(RE_LANG_CMAKE, "if(APPLE) # yes") == 5);
  assert(at(0, RE_SYNTAX_KEYWORD, 0, 2) && at(2, RE_SYNTAX_TYPE, 3, 5) && at(4, RE_SYNTAX_COMMENT, 10, 5));
  assert(line(RE_LANG_CMAKE, "IF(NOT x)") == 4 && at(0, RE_SYNTAX_KEYWORD, 0, 2)); /* commands are case-insensitive */
  assert(line(RE_LANG_CMAKE, "  target_link_libraries(rengine PUBLIC m)") == 4);
  assert(at(0, RE_SYNTAX_FUNCTION, 2, 21) && at(2, RE_SYNTAX_TYPE, 32, 6));
  assert(line(RE_LANG_CMAKE, "set(V \"${CMAKE_DIR}/x\" 3)") == 5);
  assert(at(0, RE_SYNTAX_FUNCTION, 0, 3) && at(2, RE_SYNTAX_STRING, 6, 16) && at(3, RE_SYNTAX_NUMBER, 23, 1));

  /* --- RE_LANG_PLAIN claims nothing --------------------------------------------------------- */
  st = 0;
  assert(line(RE_LANG_PLAIN, "if (x) { return \"a\"; } /* c */") == 0 && st == 0);

  /* --- capacity: spans drop from the end, the prefix stays correct --------------------------- */
  st = 0;
  n = line(RE_LANG_C, "static int add(int a, int b) { return a + b; }");
  again = 0;
  assert(n > 3 && re_syntax_line(RE_LANG_C, "static int add(int a, int b) { return a + b; }", 45, &again, small, 3) == 3);
  for (i = 0; i < 3; i++)
    assert(small[i].kind == sp[i].kind && small[i].start == sp[i].start && small[i].length == sp[i].length);
  again = 0;
  assert(re_syntax_line(RE_LANG_C, "int x = 1; /* open", 18, &again, small, 0) == 0 && again == 1);
  again = 0;
  assert(re_syntax_line(RE_LANG_C, "int x = 1; /* open", 18, &again, NULL, 8) == 0 && again == 1);

  /* --- the carry state is a pure function of the line and the incoming state ----------------- */
  st = 0;
  assert(line(RE_LANG_PYTHON, "s = '''a") == 2);
  again = st;
  st = 0;
  assert(line(RE_LANG_PYTHON, "s = '''a") == 2 && st == again);
  st = again;
  n = line(RE_LANG_PYTHON, "b''' + 2");
  again = st;
  st = (1u << 8);
  assert(line(RE_LANG_PYTHON, "b''' + 2") == n && st == again);

  /* --- robustness --------------------------------------------------------------------------- */
  st = 0;
  assert(re_syntax_line(RE_LANG_C, NULL, 10, &st, sp, CAP) == 0 && st == 0);
  assert(re_syntax_line(RE_LANG_C, "int x;", 0, &st, sp, CAP) == 0 && st == 0);
  assert(re_syntax_line(RE_LANG_C, "int x;", -4, &st, sp, CAP) == 0 && st == 0);
  assert(re_syntax_line(RE_LANG_COUNT, "int x;", 6, &st, sp, CAP) == 0);
  assert(re_syntax_line(-3, "int x;", 6, &st, sp, CAP) == 0);
  assert(re_syntax_line(RE_LANG_C, "int x;", 6, NULL, sp, CAP) == 2);
  assert(line(RE_LANG_C, "") == 0 && line(RE_LANG_MARKDOWN, "") == 0 && line(RE_LANG_JSON, "") == 0);
  assert(scan(RE_LANG_C, embedded, 13) == 4 && at(3, RE_SYNTAX_PUNCT, 9, 1));   /* NUL inside the line */
  assert(scan(RE_LANG_SHELL, embedded, 13) == 3);
  assert(scan(RE_LANG_C, "a\0\0b(", 5) == 2 && at(0, RE_SYNTAX_FUNCTION, 3, 1) && at(1, RE_SYNTAX_PUNCT, 4, 1));
  for (i = 0; i < 4096; i++) punct[i] = "+-;,"[i & 3];
  punct[4096] = 0;
  assert(line(RE_LANG_C, punct) == 1 && at(0, RE_SYNTAX_PUNCT, 0, 4096) && st == 0);
  assert(line(RE_LANG_SHELL, punct) == 1 && line(RE_LANG_CMAKE, punct) == 1);
  for (i = 0; i < 4096; i++) punct[i] = '/';
  assert(line(RE_LANG_C, punct) == 1 && at(0, RE_SYNTAX_COMMENT, 0, 4096) && st == 0);
  punct[0] = '/';
  for (i = 1; i < 4096; i++) punct[i] = '*';         /* a block comment that never terminates */
  assert(line(RE_LANG_C, punct) == 1 && at(0, RE_SYNTAX_COMMENT, 0, 4096) && st == 1);
  assert(line(RE_LANG_C, "*/") == 1 && at(0, RE_SYNTAX_COMMENT, 0, 2) && st == 0);
  for (i = 0; i < 4096; i++) punct[i] = '"';         /* 2048 literals, truncated at the capacity */
  assert(line(RE_LANG_C, punct) == CAP && at(0, RE_SYNTAX_STRING, 0, 2));
  assert(at(CAP - 1, RE_SYNTAX_STRING, (CAP - 1) * 2, 2) && st == 0);
  for (i = 0; i < 4096; i++) punct[i] = '`';
  assert(line(RE_LANG_MARKDOWN, punct) == 1 && at(0, RE_SYNTAX_PREPROC, 0, 4096) && st == (1u << 10));

  /* multi-byte UTF-8 is ordinary content and is never split by a boundary (checked in scan()) */
  st = 0;
  big = "int n\xc3\xa9xt(void) { \"h\xc3\xa9\"; }";
  assert(line(RE_LANG_C, big) == 9 && at(1, RE_SYNTAX_FUNCTION, 4, 5) && at(6, RE_SYNTAX_STRING, 18, 5));
  assert(line(RE_LANG_PYTHON, "\xe2\x9c\x93 = 1  # \xe2\x9c\x93") == 3);
  assert(at(0, RE_SYNTAX_PUNCT, 4, 1) && at(1, RE_SYNTAX_NUMBER, 6, 1) && at(2, RE_SYNTAX_COMMENT, 9, 5));

  /* --- language detection ------------------------------------------------------------------- */
  assert(re_syntax_language("syntax.c") == RE_LANG_C && re_syntax_language("editor.H") == RE_LANG_C);
  assert(re_syntax_language("a.cc") == RE_LANG_C && re_syntax_language("a.CPP") == RE_LANG_C);
  assert(re_syntax_language("a.cxx") == RE_LANG_C && re_syntax_language("a.hpp") == RE_LANG_C);
  assert(re_syntax_language("a.hh") == RE_LANG_C && re_syntax_language("view.m") == RE_LANG_C);
  assert(re_syntax_language("view.mm") == RE_LANG_C);
  assert(re_syntax_language("tools/features.py") == RE_LANG_PYTHON && re_syntax_language("t.pyi") == RE_LANG_PYTHON);
  assert(re_syntax_language("a.js") == RE_LANG_JAVASCRIPT && re_syntax_language("a.mjs") == RE_LANG_JAVASCRIPT);
  assert(re_syntax_language("a.cjs") == RE_LANG_JAVASCRIPT && re_syntax_language("a.jsx") == RE_LANG_JAVASCRIPT);
  assert(re_syntax_language("a.ts") == RE_LANG_JAVASCRIPT && re_syntax_language("a.TSX") == RE_LANG_JAVASCRIPT);
  assert(re_syntax_language("features.json") == RE_LANG_JSON);
  assert(re_syntax_language("README.md") == RE_LANG_MARKDOWN && re_syntax_language("a.MARKDOWN") == RE_LANG_MARKDOWN);
  assert(re_syntax_language("init.sh") == RE_LANG_SHELL && re_syntax_language("a.bash") == RE_LANG_SHELL);
  assert(re_syntax_language("a.zsh") == RE_LANG_SHELL);
  assert(re_syntax_language("curl.cmake") == RE_LANG_CMAKE);
  assert(re_syntax_language("CMakeLists.txt") == RE_LANG_CMAKE);                       /* bare names */
  assert(re_syntax_language("adapters/sdl2/CMakeLists.txt") == RE_LANG_CMAKE);
  assert(re_syntax_language("C:\\src\\cmakelists.TXT") == RE_LANG_CMAKE);
  assert(re_syntax_language(".bashrc") == RE_LANG_SHELL && re_syntax_language("/home/a/.zshrc") == RE_LANG_SHELL);
  assert(re_syntax_language(".profile") == RE_LANG_SHELL);
  assert(re_syntax_language("Makefile") == RE_LANG_PLAIN && re_syntax_language("makefile") == RE_LANG_PLAIN);
  assert(re_syntax_language("cmake.toml") == RE_LANG_PLAIN);                           /* unknown extension */
  assert(re_syntax_language(".gitignore") == RE_LANG_PLAIN && re_syntax_language("notes") == RE_LANG_PLAIN);
  assert(re_syntax_language("archive.tar.gz") == RE_LANG_PLAIN && re_syntax_language("a.") == RE_LANG_PLAIN);
  assert(re_syntax_language("") == RE_LANG_PLAIN && re_syntax_language(NULL) == RE_LANG_PLAIN);
  assert(re_syntax_language("dir.c/file") == RE_LANG_PLAIN);                           /* only the base name */

  assert(strcmp(re_syntax_language_name(RE_LANG_C), "C") == 0);
  assert(strcmp(re_syntax_language_name(RE_LANG_PYTHON), "Python") == 0);
  assert(strcmp(re_syntax_language_name(RE_LANG_JAVASCRIPT), "JavaScript") == 0);
  assert(strcmp(re_syntax_language_name(RE_LANG_JSON), "JSON") == 0);
  assert(strcmp(re_syntax_language_name(RE_LANG_MARKDOWN), "Markdown") == 0);
  assert(strcmp(re_syntax_language_name(RE_LANG_SHELL), "Shell") == 0);
  assert(strcmp(re_syntax_language_name(RE_LANG_CMAKE), "CMake") == 0);
  for (i = -2; i <= RE_LANG_COUNT + 1; i++) assert(re_syntax_language_name(i) != NULL);
  assert(strcmp(re_syntax_language_name(RE_LANG_COUNT), re_syntax_language_name(RE_LANG_PLAIN)) == 0);

  printf("syntax spans: %d languages, block/string carry, capacity drop, detection and byte-safety checks passed\n",
         RE_LANG_COUNT - 1);
  return 0;
}

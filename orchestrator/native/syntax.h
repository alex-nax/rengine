/* Line-based syntax spans for the editor (spec 079).
 *
 * The editor draws one line at a time and must colour it without re-reading the file, so a language
 * is tokenised per line with a small carry state that survives to the next line: block comments and
 * multi-line strings live in that state and nothing else does. A line's spans are produced into a
 * caller-owned array, so this module allocates nothing and holds no per-file state.
 *
 * Kinds are deliberately few. They are the roles a colour scheme can name, not a parse tree: a
 * scheme assigns one colour per kind, which is what makes schemes interchangeable across languages.
 */
#ifndef RENGINE_SYNTAX_H
#define RENGINE_SYNTAX_H
#include <stdbool.h>
#include <stdint.h>

enum {                       /* token roles a colour scheme assigns to */
  RE_SYNTAX_TEXT = 0,        /* anything a language does not claim */
  RE_SYNTAX_KEYWORD,         /* language keywords and reserved words */
  RE_SYNTAX_TYPE,            /* built-in types and language constants (true, nil, NULL) */
  RE_SYNTAX_STRING,          /* string and character literals, including their quotes */
  RE_SYNTAX_NUMBER,          /* numeric literals */
  RE_SYNTAX_COMMENT,         /* comments, line and block */
  RE_SYNTAX_FUNCTION,        /* an identifier immediately followed by '(' */
  RE_SYNTAX_PREPROC,         /* preprocessor and pragma lines, decorators, front matter */
  RE_SYNTAX_PUNCT,           /* operators and separators */
  RE_SYNTAX_COUNT
};

enum {                       /* languages; RE_LANG_PLAIN produces no spans */
  RE_LANG_PLAIN = 0,
  RE_LANG_C,                 /* C, C++, Objective-C, headers */
  RE_LANG_PYTHON,
  RE_LANG_JAVASCRIPT,        /* JavaScript, TypeScript, JSX */
  RE_LANG_JSON,
  RE_LANG_MARKDOWN,
  RE_LANG_SHELL,
  RE_LANG_CMAKE,
  RE_LANG_COUNT
};

typedef struct {
  uint32_t start;            /* byte offset within the line */
  uint32_t length;           /* byte length; spans never overlap and are emitted left to right */
  uint8_t kind;              /* RE_SYNTAX_* */
} ReSyntaxSpan;

/* Language for a file name (case-insensitive extension, plus known bare names like CMakeLists.txt).
 * Returns RE_LANG_PLAIN when nothing matches. */
int re_syntax_language(const char *filename);

/* Human name of a language, for the editor's status line. Never NULL. */
const char *re_syntax_language_name(int language);

/* Tokenise one line. `state` carries block context between lines: initialise it to 0 for the first
 * line of a file and pass the same variable back for each following line. `line` need not be
 * NUL-terminated; `length` is its byte length. Writes at most `capacity` spans and returns how many
 * were written. Spans that would exceed the capacity are dropped from the end, so a caller with a
 * small array still gets a correctly coloured prefix. */
int re_syntax_line(int language, const char *line, int length, uint32_t *state, ReSyntaxSpan *spans, int capacity);

#endif

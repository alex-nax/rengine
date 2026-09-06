/* Line-based syntax spans for the editor; the contract lives in syntax.h.
 *
 * One pass per line, no allocation, no file-level state: everything that must survive to the next
 * line lives in the caller's uint32_t, and the tokeniser is a pure function of (line, state), so
 * re-tokenising a line always reproduces the same following state.
 *
 * Carry state bit layout (bits not listed are reserved and always written as zero):
 *   bits 0-7   block comment depth. C, C++, Objective-C and JavaScript block comments do not nest,
 *              so the field only ever holds 0 or 1 today; it is a depth so a nesting language can
 *              reuse it without changing the contract.
 *   bits 8-9   unterminated multi-line string: 0 none, 1 Python ''', 2 Python """, 3 a JavaScript
 *              template literal. Shell heredocs are out of scope.
 *   bit  10    a Markdown fenced code block is open.
 *   bit  11    that fence was opened with ~~~ rather than ```; only meaningful with bit 10.
 */
#include "syntax.h"

#include <string.h>

#define RE_ST_COMMENT 0x000000ffu /* bits 0-7  */
#define RE_ST_STRING  0x00000300u /* bits 8-9  */
#define RE_ST_SHIFT   8
#define RE_ST_FENCE   0x00000400u /* bit 10 */
#define RE_ST_TILDE   0x00000800u /* bit 11 */

enum { RE_STR_NONE = 0, RE_STR_SQ3 = 1, RE_STR_DQ3 = 2, RE_STR_TICK = 3 };

enum {                        /* per-language switches; the tables below are the only place they are set */
  LF_SLASH    = 1u << 0,      /* // line and slash-star block comments */
  LF_HASH     = 1u << 1,      /* # to end of line */
  LF_HASHWORD = 1u << 2,      /* ... but only at a word boundary (shell: foo#bar is one word) */
  LF_SQUOTE   = 1u << 3,      /* '...' is a string or character literal */
  LF_TRIPLE   = 1u << 4,      /* Python ''' and """ carry across lines */
  LF_TICK     = 1u << 5,      /* JavaScript template literal carries across lines */
  LF_PREPROC  = 1u << 6,      /* C # directive at the head of a line */
  LF_AT       = 1u << 7,      /* Objective-C @keyword and @"string" */
  LF_DECOR    = 1u << 8,      /* Python @decorator at the head of a line */
  LF_PREFIX   = 1u << 9,      /* Python r"" b"" f"" rb"" string prefixes */
  LF_DOLLAR   = 1u << 10,     /* $ is an identifier byte (JavaScript) */
  LF_UPPER    = 1u << 11,     /* ALL_CAPS words are types (CMake argument keywords and variables) */
  LF_NOCASE   = 1u << 12,     /* keyword tables match case-insensitively (CMake) */
  LF_JSONKEY  = 1u << 13,     /* a string followed by ':' is a key, not a value */
  LF_SHEBANG  = 1u << 14      /* #! on the first byte is front matter, not a comment */
};

typedef struct {
  const char *const *keywords; /* NULL-terminated, lower case when LF_NOCASE is set */
  const char *const *types;
  const char *punct;           /* bytes grouped into RE_SYNTAX_PUNCT runs; never contains a quote */
  unsigned flags;
} ReLangSpec;

static const char *const c_keywords[] = {
  "alignas", "alignof", "auto", "break", "case", "catch", "class", "const", "constexpr", "continue",
  "default", "delete", "do", "else", "enum", "explicit", "extern", "for", "friend", "goto", "if",
  "inline", "namespace", "new", "operator", "private", "protected", "public", "register", "restrict",
  "return", "sizeof", "static", "static_assert", "struct", "switch", "template", "this", "throw",
  "try", "typedef", "typename", "union", "using", "virtual", "volatile", "while", "_Alignas",
  "_Atomic", "_Generic", "_Noreturn", "_Static_assert", "_Thread_local", NULL };
static const char *const c_types[] = {
  "bool", "char", "char16_t", "char32_t", "double", "float", "int", "long", "short", "signed",
  "unsigned", "void", "wchar_t", "size_t", "ssize_t", "ptrdiff_t", "intptr_t", "uintptr_t",
  "int8_t", "int16_t", "int32_t", "int64_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t",
  "FILE", "va_list", "true", "false", "NULL", "nullptr", "nil", "YES", "NO", "id", "instancetype", NULL };

static const char *const py_keywords[] = {
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
  "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
  "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", NULL };
static const char *const py_types[] = {
  "True", "False", "None", "self", "cls", "bool", "bytes", "dict", "float", "frozenset", "int",
  "list", "object", "set", "str", "tuple", "type", "NotImplemented", "Ellipsis", NULL };

static const char *const js_keywords[] = {
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "declare", "default", "delete", "do", "else", "export", "extends", "finally", "for",
  "from", "function", "if", "implements", "import", "in", "instanceof", "interface", "let",
  "namespace", "new", "of", "private", "protected", "public", "readonly", "return", "satisfies",
  "static", "super", "switch", "throw", "try", "typeof", "var", "void", "while", "with", "yield", NULL };
static const char *const js_types[] = {
  "any", "bigint", "boolean", "never", "null", "number", "object", "string", "symbol", "this",
  "true", "false", "undefined", "unknown", NULL };

static const char *const json_types[] = { "true", "false", "null", NULL };

static const char *const sh_keywords[] = {
  "alias", "break", "case", "continue", "declare", "do", "done", "elif", "else", "esac", "exit",
  "export", "fi", "for", "function", "if", "in", "local", "readonly", "return", "select", "set",
  "shift", "source", "then", "time", "trap", "typeset", "until", "unset", "while", NULL };
static const char *const sh_types[] = {
  "cd", "command", "echo", "eval", "exec", "false", "kill", "let", "printf", "pwd", "read", "test",
  "true", "umask", "wait", NULL };

static const char *const cmake_keywords[] = { /* control flow only: every other command is a call */
  "break", "continue", "else", "elseif", "endforeach", "endfunction", "endif", "endmacro",
  "endwhile", "foreach", "function", "if", "macro", "return", "while", NULL };

static const ReLangSpec lang_specs[RE_LANG_COUNT] = {
  { NULL, NULL, "", 0 },                                                       /* RE_LANG_PLAIN */
  { c_keywords, c_types, "+-*/%=<>!&|^~?:;,.()[]{}#\\",
    LF_SLASH | LF_SQUOTE | LF_PREPROC | LF_AT },                               /* RE_LANG_C */
  { py_keywords, py_types, "+-*/%=<>!&|^~?:;,.()[]{}@",
    LF_HASH | LF_SQUOTE | LF_TRIPLE | LF_DECOR | LF_PREFIX | LF_SHEBANG },     /* RE_LANG_PYTHON */
  { js_keywords, js_types, "+-*/%=<>!&|^~?:;,.()[]{}",
    LF_SLASH | LF_SQUOTE | LF_TICK | LF_DOLLAR },                              /* RE_LANG_JAVASCRIPT */
  { NULL, json_types, "{}[],:", LF_JSONKEY },                                  /* RE_LANG_JSON */
  { NULL, NULL, "", 0 },                                                       /* RE_LANG_MARKDOWN, own scanner */
  { sh_keywords, sh_types, "|&;<>()[]{}=+-*/%!?:,.~$\\",
    LF_HASH | LF_HASHWORD | LF_SQUOTE | LF_SHEBANG },                          /* RE_LANG_SHELL */
  { cmake_keywords, NULL, "()[]{}$;:,.=<>!-+*/\\",
    LF_HASH | LF_UPPER | LF_NOCASE }                                           /* RE_LANG_CMAKE */
};

/* --- span emission ------------------------------------------------------------------------- */

typedef struct { ReSyntaxSpan *spans; int capacity; int count; int limit; } Emitter;

/* Clamps to the line, drops RE_SYNTAX_TEXT and empty spans, and stops writing at the capacity so
 * an over-full line keeps a correct prefix instead of a corrupted array. */
static void emit(Emitter *e, int kind, int start, int end) {
  if (start < 0) start = 0;
  if (end > e->limit) end = e->limit;
  if (end <= start || kind == RE_SYNTAX_TEXT || e->count >= e->capacity) return;
  e->spans[e->count].start = (uint32_t)start;
  e->spans[e->count].length = (uint32_t)(end - start);
  e->spans[e->count].kind = (uint8_t)kind;
  e->count++;
}

/* --- byte classes (ASCII only; every byte >= 0x80 is ordinary identifier content, which is what
 * keeps a span boundary from ever splitting a UTF-8 sequence) --------------------------------- */

static bool is_space(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\v' || c == '\f'; }
static bool is_digit(char c) { return c >= '0' && c <= '9'; }
static bool is_alpha(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
static char lower(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c + ('a' - 'A')) : c; }

static bool is_ident_byte(const ReLangSpec *sp, char c) {
  return is_alpha(c) || is_digit(c) || c == '_' || (unsigned char)c >= 0x80 ||
         (c == '$' && (sp->flags & LF_DOLLAR) != 0);
}
static bool is_ident_start(const ReLangSpec *sp, char c) { return is_ident_byte(sp, c) && !is_digit(c); }
/* A NUL byte inside the line must not match: strchr would otherwise find the terminator. */
static bool is_punct(const ReLangSpec *sp, char c) { return c != 0 && strchr(sp->punct, c) != NULL; }

static bool word_is(const char *w, int n, const char *key, bool nocase) {
  int i;
  for (i = 0; i < n; i++) {
    char a = nocase ? lower(w[i]) : w[i];
    if (key[i] == 0 || a != key[i]) return false;
  }
  return key[n] == 0;
}

static int classify(const ReLangSpec *sp, const char *w, int n) {
  bool nocase = (sp->flags & LF_NOCASE) != 0;
  const char *const *t;
  for (t = sp->keywords; t != NULL && *t != NULL; t++) if (word_is(w, n, *t, nocase)) return RE_SYNTAX_KEYWORD;
  for (t = sp->types; t != NULL && *t != NULL; t++) if (word_is(w, n, *t, nocase)) return RE_SYNTAX_TYPE;
  return RE_SYNTAX_TEXT;
}

/* CMake spells its argument keywords and variables in caps: PUBLIC, REQUIRED, CMAKE_BUILD_TYPE. */
static bool is_caps_word(const char *w, int n) {
  int i, letters = 0;
  if (n < 2) return false;
  for (i = 0; i < n; i++) {
    if (w[i] >= 'A' && w[i] <= 'Z') letters++;
    else if (!is_digit(w[i]) && w[i] != '_') return false;
  }
  return letters > 0;
}

static bool is_string_prefix(const char *w, int n) { /* Python r/b/f/u, at most two of them */
  int i;
  if (n < 1 || n > 2) return false;
  for (i = 0; i < n; i++) {
    char c = lower(w[i]);
    if (c != 'r' && c != 'b' && c != 'f' && c != 'u') return false;
  }
  return true;
}

/* --- shared scanners ------------------------------------------------------------------------ */

/* Block comment body. `start` opens the span (the slash, or 0 when resuming a carried comment) and
 * `from` is where the search for the terminator begins. Returns the index just past the comment. */
static int scan_block_comment(const char *line, int length, int start, int from, uint32_t *state, Emitter *e) {
  int i = from;
  bool closed = false;
  while (i + 1 < length) {
    if (line[i] == '*' && line[i + 1] == '/') { i += 2; closed = true; break; }
    i++;
  }
  if (!closed) i = length;
  emit(e, RE_SYNTAX_COMMENT, start, i);
  *state = closed ? (*state & ~RE_ST_COMMENT) : ((*state & ~RE_ST_COMMENT) | 1u);
  return i;
}

/* A carried multi-line string, resumed at byte 0. Returns where ordinary scanning may continue. */
static int resume_string(uint32_t kind, const char *line, int length, uint32_t *state, Emitter *e) {
  char q = (kind == RE_STR_SQ3) ? '\'' : (kind == RE_STR_DQ3) ? '"' : '`';
  bool triple = (kind != RE_STR_TICK);
  bool closed = false;
  int i = 0;
  while (i < length) {
    if (line[i] == '\\') { i += 2; continue; }
    if (line[i] == q && (!triple || (i + 3 <= length && line[i + 1] == q && line[i + 2] == q))) {
      i += triple ? 3 : 1;
      closed = true;
      break;
    }
    i++;
  }
  if (i > length) i = length;
  emit(e, RE_SYNTAX_STRING, 0, i);
  if (closed) *state &= ~RE_ST_STRING;
  return closed ? i : length;
}

/* One string literal. `start` opens the span, which may include a Python prefix or an Objective-C
 * '@' before the quote at `q`. Returns the index just past the literal. */
static int scan_string(const ReLangSpec *sp, const char *line, int length, int start, int q,
                       uint32_t *state, Emitter *e) {
  char quote = line[q];
  bool triple = (sp->flags & LF_TRIPLE) != 0 && (quote == '"' || quote == '\'') &&
                q + 3 <= length && line[q + 1] == quote && line[q + 2] == quote;
  bool closed = false;
  int i = q + (triple ? 3 : 1);
  int end;
  while (i < length) {
    if (line[i] == '\\') { i += 2; continue; }
    if (line[i] == quote && (!triple || (i + 3 <= length && line[i + 1] == quote && line[i + 2] == quote))) {
      i += triple ? 3 : 1;
      closed = true;
      break;
    }
    i++;
  }
  end = (i > length) ? length : i;
  if (!closed) {
    if (triple) *state = (*state & ~RE_ST_STRING) | ((quote == '"' ? (uint32_t)RE_STR_DQ3 : (uint32_t)RE_STR_SQ3) << RE_ST_SHIFT);
    else if (quote == '`') *state = (*state & ~RE_ST_STRING) | ((uint32_t)RE_STR_TICK << RE_ST_SHIFT);
    end = length; /* an unterminated single-line literal simply ends with the line */
  }
  if (closed && (sp->flags & LF_JSONKEY) != 0) {
    int j = end;
    while (j < length && is_space(line[j])) j++;
    if (j < length && line[j] == ':') { emit(e, RE_SYNTAX_KEYWORD, start, end); return end; }
  }
  emit(e, RE_SYNTAX_STRING, start, end);
  return end;
}

/* Numeric literal, including 0x/0b prefixes, digit separators and exponents. */
static int scan_number(const char *line, int length, int i) {
  bool hex = (line[i] == '0' && i + 1 < length && (line[i + 1] == 'x' || line[i + 1] == 'X'));
  int start = i;
  i++;
  while (i < length) {
    char c = line[i];
    if (is_alpha(c) || is_digit(c) || c == '_' || (c == '.' && !hex)) { i++; continue; }
    if ((c == '+' || c == '-') && i > start) {
      char p = lower(line[i - 1]);
      if ((!hex && p == 'e') || (hex && p == 'p')) { i++; continue; }
    }
    break;
  }
  return i;
}

/* --- the shared code scanner ---------------------------------------------------------------- */

static void scan_code(const ReLangSpec *sp, const char *line, int length, uint32_t *state, Emitter *e) {
  int i = 0, head = 0;
  if ((*state & RE_ST_COMMENT) != 0) {
    i = scan_block_comment(line, length, 0, 0, state, e);
    if ((*state & RE_ST_COMMENT) != 0) return;
  } else if ((*state & RE_ST_STRING) != 0) {
    i = resume_string((*state & RE_ST_STRING) >> RE_ST_SHIFT, line, length, state, e);
  }
  while (head < length && is_space(line[head])) head++;
  if (i == 0 && (sp->flags & LF_SHEBANG) != 0 && length > 1 && line[0] == '#' && line[1] == '!') {
    emit(e, RE_SYNTAX_PREPROC, 0, length);
    return;
  }
  while (i < length) {
    char c = line[i];
    int s = i;
    if (is_space(c)) { i++; continue; }
    if ((sp->flags & LF_SLASH) != 0 && c == '/' && i + 1 < length) {
      if (line[i + 1] == '/') { emit(e, RE_SYNTAX_COMMENT, i, length); return; }
      if (line[i + 1] == '*') { i = scan_block_comment(line, length, i, i + 2, state, e); continue; }
    }
    if ((sp->flags & LF_HASH) != 0 && c == '#' &&
        ((sp->flags & LF_HASHWORD) == 0 || i == 0 || is_space(line[i - 1]) || is_punct(sp, line[i - 1]))) {
      emit(e, RE_SYNTAX_COMMENT, i, length);
      return;
    }
    if ((sp->flags & LF_PREPROC) != 0 && c == '#' && i == head) { /* #include, # define, #pragma */
      i++;
      while (i < length && is_space(line[i])) i++;
      { int w = i;
        while (i < length && is_ident_byte(sp, line[i])) i++;
        emit(e, RE_SYNTAX_PREPROC, s, i);
        if (word_is(line + w, i - w, "include", false) || word_is(line + w, i - w, "import", false)) {
          while (i < length && is_space(line[i])) i++;
          if (i < length && line[i] == '<') {
            int a = i;
            while (i < length && line[i] != '>') i++;
            if (i < length) i++;
            emit(e, RE_SYNTAX_STRING, a, i);
          }
        }
      }
      continue;
    }
    if ((sp->flags & LF_DECOR) != 0 && c == '@' && i == head && i + 1 < length && is_ident_start(sp, line[i + 1])) {
      i++;
      while (i < length && (is_ident_byte(sp, line[i]) || line[i] == '.')) i++;
      emit(e, RE_SYNTAX_PREPROC, s, i);
      continue;
    }
    if ((sp->flags & LF_AT) != 0 && c == '@' && i + 1 < length) { /* Objective-C @"str" and @keyword */
      if (line[i + 1] == '"') { i = scan_string(sp, line, length, s, i + 1, state, e); continue; }
      if (is_ident_start(sp, line[i + 1])) {
        i++;
        while (i < length && is_ident_byte(sp, line[i])) i++;
        emit(e, RE_SYNTAX_KEYWORD, s, i);
        continue;
      }
    }
    if (c == '"' || (c == '\'' && (sp->flags & LF_SQUOTE) != 0) || (c == '`' && (sp->flags & LF_TICK) != 0)) {
      i = scan_string(sp, line, length, s, i, state, e);
      continue;
    }
    if (is_ident_start(sp, c)) {
      int kind;
      while (i < length && is_ident_byte(sp, line[i])) i++;
      if ((sp->flags & LF_PREFIX) != 0 && i < length && (line[i] == '"' || line[i] == '\'') &&
          is_string_prefix(line + s, i - s)) {
        i = scan_string(sp, line, length, s, i, state, e);
        continue;
      }
      kind = classify(sp, line + s, i - s);
      if (kind == RE_SYNTAX_TEXT && i < length && line[i] == '(') kind = RE_SYNTAX_FUNCTION;
      if (kind == RE_SYNTAX_TEXT && (sp->flags & LF_UPPER) != 0 && is_caps_word(line + s, i - s)) kind = RE_SYNTAX_TYPE;
      emit(e, kind, s, i);
      continue;
    }
    if (is_digit(c) || (c == '.' && i + 1 < length && is_digit(line[i + 1]) &&
                        (i == 0 || !is_ident_byte(sp, line[i - 1])))) {
      i = scan_number(line, length, i);
      emit(e, RE_SYNTAX_NUMBER, s, i);
      continue;
    }
    if (is_punct(sp, c)) {
      while (i < length && is_punct(sp, line[i])) {
        if ((sp->flags & LF_SLASH) != 0 && line[i] == '/' && i + 1 < length &&
            (line[i + 1] == '/' || line[i + 1] == '*')) break;
        if ((sp->flags & LF_HASH) != 0 && line[i] == '#') break;
        i++;
      }
      if (i == s) { i++; continue; } /* the run stopped on its first byte: it opens a comment */
      emit(e, RE_SYNTAX_PUNCT, s, i);
      continue;
    }
    i++; /* NUL, control bytes and anything else the language does not claim */
  }
}

/* --- Markdown -------------------------------------------------------------------------------- */

/* Inline scan of one Markdown line: code spans and link targets only. Emphasis is deliberately not
 * claimed; it needs cross-line context to get right and reads badly when it guesses wrong. */
static void scan_markdown_inline(const char *line, int length, int i, Emitter *e) {
  while (i < length) {
    char c = line[i];
    if (c == '\\') { i += 2; continue; }
    if (c == '`') {
      int n = 0, j, end = -1;
      while (i + n < length && line[i + n] == '`') n++;
      j = i + n;
      while (j < length && end < 0) {
        if (line[j] == '`') {
          int k = 0;
          while (j + k < length && line[j + k] == '`') k++;
          if (k == n) end = j + k; else j += k;
        } else j++;
      }
      if (end > 0) { emit(e, RE_SYNTAX_STRING, i, end); i = end; } else i += n;
      continue;
    }
    if (c == '(' && i > 0 && line[i - 1] == ']') { /* the target half of [text](url) */
      int j = i + 1, depth = 1;
      while (j < length && depth > 0) {
        if (line[j] == '(') depth++;
        else if (line[j] == ')') depth--;
        j++;
      }
      emit(e, RE_SYNTAX_STRING, i, j);
      i = j;
      continue;
    }
    i++;
  }
}

static void scan_markdown(const char *line, int length, uint32_t *state, Emitter *e) {
  int indent = 0, run = 0, i;
  char fence = 0;
  while (indent < length && is_space(line[indent])) indent++;
  if (indent < length && (line[indent] == '`' || line[indent] == '~')) {
    fence = line[indent];
    while (indent + run < length && line[indent + run] == fence) run++;
  }
  if ((*state & RE_ST_FENCE) != 0) {
    char open = ((*state & RE_ST_TILDE) != 0) ? '~' : '`';
    if (run >= 3 && fence == open) {
      *state &= ~(RE_ST_FENCE | RE_ST_TILDE);
      emit(e, RE_SYNTAX_PREPROC, 0, length);
    } else emit(e, RE_SYNTAX_STRING, 0, length); /* fenced code is one span; no nested language */
    return;
  }
  if (run >= 3) {
    *state |= RE_ST_FENCE;
    if (fence == '~') *state |= RE_ST_TILDE; else *state &= ~RE_ST_TILDE;
    emit(e, RE_SYNTAX_PREPROC, 0, length);
    return;
  }
  i = indent;
  if (i < length && line[i] == '#') {
    int h = 0;
    while (i + h < length && line[i + h] == '#') h++;
    if (h <= 6 && (i + h >= length || is_space(line[i + h]))) { emit(e, RE_SYNTAX_KEYWORD, i, length); return; }
  }
  if (i < length && (line[i] == '-' || line[i] == '=' || line[i] == '*' || line[i] == '_')) {
    char m = line[i];
    int j = i, n = 0;
    bool only = true;
    for (; j < length && only; j++) {
      if (line[j] == m) n++;
      else if (!is_space(line[j])) only = false;
    }
    if (only && n >= 3) { emit(e, RE_SYNTAX_PUNCT, i, length); return; } /* rule, setext, front matter */
  }
  if (i < length && line[i] == '>') {
    int s = i;
    while (i < length && line[i] == '>') i++;
    emit(e, RE_SYNTAX_PUNCT, s, i);
    while (i < length && is_space(line[i])) i++;
  }
  if (i + 1 < length && (line[i] == '-' || line[i] == '*' || line[i] == '+') && is_space(line[i + 1])) {
    emit(e, RE_SYNTAX_PUNCT, i, i + 1);
    i++;
  } else if (i < length && is_digit(line[i])) {
    int j = i;
    while (j < length && is_digit(line[j])) j++;
    if (j + 1 < length && (line[j] == '.' || line[j] == ')') && is_space(line[j + 1])) {
      emit(e, RE_SYNTAX_PUNCT, i, j + 1);
      i = j + 1;
    }
  }
  scan_markdown_inline(line, length, i, e);
}

/* --- public entry points --------------------------------------------------------------------- */

typedef struct { const char *name; int language; } ReLangName;

static const ReLangName lang_extensions[] = {
  { "c", RE_LANG_C }, { "h", RE_LANG_C }, { "cc", RE_LANG_C }, { "cpp", RE_LANG_C },
  { "cxx", RE_LANG_C }, { "c++", RE_LANG_C }, { "hpp", RE_LANG_C }, { "hh", RE_LANG_C },
  { "hxx", RE_LANG_C }, { "inl", RE_LANG_C }, { "m", RE_LANG_C }, { "mm", RE_LANG_C },
  { "py", RE_LANG_PYTHON }, { "pyi", RE_LANG_PYTHON }, { "pyw", RE_LANG_PYTHON },
  { "js", RE_LANG_JAVASCRIPT }, { "mjs", RE_LANG_JAVASCRIPT }, { "cjs", RE_LANG_JAVASCRIPT },
  { "jsx", RE_LANG_JAVASCRIPT }, { "ts", RE_LANG_JAVASCRIPT }, { "tsx", RE_LANG_JAVASCRIPT },
  { "mts", RE_LANG_JAVASCRIPT }, { "cts", RE_LANG_JAVASCRIPT },
  { "json", RE_LANG_JSON }, { "jsonc", RE_LANG_JSON },
  { "md", RE_LANG_MARKDOWN }, { "markdown", RE_LANG_MARKDOWN },
  { "sh", RE_LANG_SHELL }, { "bash", RE_LANG_SHELL }, { "zsh", RE_LANG_SHELL },
  { "cmake", RE_LANG_CMAKE },
  { NULL, RE_LANG_PLAIN }
};

/* Whole file names, matched case-insensitively; the dotfiles are the shells' own start-up files. */
static const ReLangName lang_names[] = {
  { "cmakelists.txt", RE_LANG_CMAKE },
  { ".bashrc", RE_LANG_SHELL }, { ".bash_profile", RE_LANG_SHELL }, { ".bash_aliases", RE_LANG_SHELL },
  { ".bash_logout", RE_LANG_SHELL }, { ".zshrc", RE_LANG_SHELL }, { ".zshenv", RE_LANG_SHELL },
  { ".zprofile", RE_LANG_SHELL }, { ".zlogin", RE_LANG_SHELL }, { ".zlogout", RE_LANG_SHELL },
  { ".profile", RE_LANG_SHELL }, { ".kshrc", RE_LANG_SHELL },
  { NULL, RE_LANG_PLAIN }
};

int re_syntax_language(const char *filename) {
  const char *base, *p, *dot = NULL;
  const ReLangName *entry;
  int i, n;
  if (filename == NULL) return RE_LANG_PLAIN;
  base = filename;
  for (p = filename; *p != 0; p++) if (*p == '/' || *p == '\\') base = p + 1;
  n = (int)strlen(base);
  if (n == 0) return RE_LANG_PLAIN;
  for (entry = lang_names; entry->name != NULL; entry++)
    if (word_is(base, n, entry->name, true)) return entry->language;
  for (i = 1; i < n; i++) if (base[i] == '.') dot = base + i; /* a leading dot is a name, not an extension */
  if (dot == NULL) return RE_LANG_PLAIN;
  for (entry = lang_extensions; entry->name != NULL; entry++)
    if (word_is(dot + 1, n - (int)(dot + 1 - base), entry->name, true)) return entry->language;
  return RE_LANG_PLAIN;
}

const char *re_syntax_language_name(int language) {
  static const char *const names[RE_LANG_COUNT] = {
    "Plain Text", "C", "Python", "JavaScript", "JSON", "Markdown", "Shell", "CMake"
  };
  if (language < 0 || language >= RE_LANG_COUNT) return names[RE_LANG_PLAIN];
  return names[language];
}

int re_syntax_line(int language, const char *line, int length, uint32_t *state, ReSyntaxSpan *spans, int capacity) {
  uint32_t local = 0;
  Emitter e;
  e.spans = spans;
  e.capacity = (spans != NULL && capacity > 0) ? capacity : 0;
  e.count = 0;
  e.limit = length;
  if (state == NULL) state = &local;
  if (line == NULL || length <= 0 || language <= RE_LANG_PLAIN || language >= RE_LANG_COUNT) return 0;
  if (language == RE_LANG_MARKDOWN) scan_markdown(line, length, state, &e);
  else scan_code(&lang_specs[language], line, length, state, &e);
  return e.count;
}

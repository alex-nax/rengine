#!/usr/bin/env python3
"""Bridge the desktop's theme source and the Claude Design system project.

  generate            write orchestrator/native/theme.h from orchestrator/native/theme.json, refresh the
                      design/tokens.json mirror from design/tokens.css and design/manifest.json from the cards
  check               fail when generated output is stale, a card is malformed or not self-contained, the
                      token mirror drifts, a native source hard-codes a colour or layout row size, or a
                      file above the draw list uses graphics-API rendering symbols, or a CMakeLists.txt
                      was written by hand instead of generated from cmake.toml, or shipping code
                      hard-codes the product name instead of reading the generated one
  product [PATH]      print the declared product name and every hard-coded occurrence as JSON,
                      exiting non-zero when there is one; PATH scans one file or directory
                      instead of the shipping roots (spec 108)
  resolve [PRESET]    print the design tokens of a preset (default, teal, light) as JSON with colours
                      resolved to sRGB 8-bit, for renderer and theme work

Two sources exist on purpose: the shipping desktop draws from the interim theme.json (spec 064) until the
GPU renderer lands (spec 066); the Claude Design project owns design/tokens.css. Standard library only.
"""
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESIGN = ROOT / "design"
TOKENS_CSS = DESIGN / "tokens.css"
TOKENS_JSON = DESIGN / "tokens.json"
STYLES_CSS = DESIGN / "styles.css"
BASE_CSS = DESIGN / "base.css"
MANIFEST = DESIGN / "manifest.json"
PREVIEWS = DESIGN / "previews"
NATIVE = ROOT / "orchestrator" / "native"
NATIVE_THEME = NATIVE / "theme.json"
THEME_H = NATIVE / "theme.h"
THEME_C = NATIVE / "theme.c"
CARDS_JSON = DESIGN / "cards.json"
ICONS_JSON = NATIVE / "icons.json"
ICONS_H = NATIVE / "render" / "icons.h"
PRODUCT_MJS = ROOT / "orchestrator" / "runtime" / "product.mjs"
SYNTAX_JSON = NATIVE / "syntax.json"
SYNTAX_H = NATIVE / "render" / "syntax_theme.h"
ICON_SPAN = re.compile(r'<span class="re-icon">([^<]*)</span>')
MICROUI = ["text", "border", "windowbg", "titlebg", "titletext", "panelbg", "button", "buttonhover",
           "buttonfocus", "base", "basehover", "basefocus", "scrollbase", "scrollthumb"]
MICROUI_METRICS = ["padding", "spacing", "indent", "title-height", "scrollbar-size", "thumb-size", "control-width"]
LAYERS = ("palette", "semantic", "views")
NAME = re.compile(r"[a-z][a-z0-9-]*")
CARD = re.compile(r'^<!-- @dsCard((?:\s+[a-z]+="[^"]*")+)\s*-->\s*$')
ATTR = re.compile(r'([a-z]+)="([^"]*)"')
LINK = re.compile(r'<link\s+rel="stylesheet"\s+href="([^"]*)"\s*>')
EXTERNAL = re.compile(r"""(?:src|href)\s*=\s*["']?\s*(?:https?:)?//|@import\s+url\(\s*["']?(?:https?:)?//|url\(\s*["']?\s*(?:https?:)?//""")
BLOCK = re.compile(r'(:root|\[data-theme="([a-z0-9-]+)"\])\s*\{([^}]*)\}')
DECLARATION = re.compile(r"(--[a-z0-9-]+)\s*:\s*([^;]+);")
COMMENT = re.compile(r"/\*.*?\*/", re.S)
VAR = re.compile(r"var\((--[a-z0-9-]+)\)")
HEX = re.compile(r"#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})")
RGB = re.compile(r"rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[/,]\s*([0-9.]+%?))?\s*\)")
OKLCH = re.compile(r"oklch\(\s*([0-9.]+%?)\s+([0-9.]+)\s+([0-9.]+)(?:deg)?\s*(?:/\s*([0-9.]+%?))?\s*\)")
LITERAL = re.compile(r"mu_color\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)"
                     r"|vterm_color_rgb\(\s*&\w+\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)")
RENDER_API = re.compile(r"SDL_Render|SDL_Texture|SDL_CreateRenderer|SDL_DestroyRenderer|SDL_SetTexture|SDL_Vertex|SDL_FRect|SDL_FLIP|SDL_Metal|CAMetal"
                        r"|\bgl[A-Z]\w*\(|\bGL_[A-Z]|\bMTL[A-Z]|\bvk[A-Z]\w*\(|\bVK_[A-Z]")
LAYOUT_ROW = re.compile(r"mu_layout_row\(\s*\w+\s*,\s*\d+\s*,\s*\(int\[\]\)\{([^}]*)\}\s*,\s*([^;]*?)\)\s*;")


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def rel(path):
    return path.relative_to(ROOT).as_posix()


# ---- interim native theme (theme.json v1) -> theme.h --------------------------------------------

def load_native_theme():
    tokens = json.loads(NATIVE_THEME.read_text(encoding="utf-8"))
    errors = []
    colors = tokens.get("colors", {})
    for name, color in colors.items():
        token = color.get("token") if isinstance(color, dict) else None
        if not NAME.fullmatch(name) or not isinstance(token, str) or not NAME.fullmatch(token):
            errors.append("colour %r needs a token binding into design/tokens.css" % name)
    for name, token in tokens.get("token-metrics", {}).items():
        if not NAME.fullmatch(name) or not isinstance(token, str) or not NAME.fullmatch(token):
            errors.append("token metric %r needs a token binding into design/tokens.css" % name)
        if name in tokens.get("metrics", {}).get("design", {}):
            errors.append("token metric %r also exists as a literal design metric" % name)
    mapping = tokens.get("microui", {})
    if list(mapping) != MICROUI:
        errors.append("microui mapping must list exactly: " + ", ".join(MICROUI))
    for slot, name in mapping.items():
        if name not in colors:
            errors.append("microui slot %s maps to unknown colour %r" % (slot, name))
    metrics = tokens.get("metrics", {})
    for group, values in metrics.items():
        for key, value in values.items():
            if not NAME.fullmatch(group) or not NAME.fullmatch(key) or not is_int(value) or value < 0:
                errors.append("metric %s.%s needs a non-negative integer" % (group, key))
    if any(key not in metrics.get("microui", {}) for key in MICROUI_METRICS):
        errors.append("metrics.microui must define: " + ", ".join(MICROUI_METRICS))
    typography = tokens.get("typography", {})
    for key in ("size", "line-height"):
        if not is_int(typography.get(key)) or typography[key] <= 0:
            errors.append("typography.%s needs a positive integer" % key)
    errors += product_errors(tokens.get("product"))
    if errors:
        raise SystemExit("\n".join("ERROR: theme.json: " + e for e in errors))
    return tokens


# ---- the product's own name (charter D41, spec 108) ----------------------------------------------
#
# One declaration, two generated outputs, and a guard that fails when the word is typed into shipping
# code instead. The name lives beside the theme tokens because D41 asked for it to be generated "the
# way theme tokens are": this file already turns declared values into RE_* constants, so a rename is
# a data edit rather than a search across four consumers that nobody can prove is complete.

PRODUCT_KEYS = ("name", "family")


def product_errors(product):
    if not isinstance(product, dict):
        return ["product must declare the product's own name and its umbrella (charter D41)"]
    errors = []
    for key in PRODUCT_KEYS:
        value = product.get(key)
        if not isinstance(value, str) or not value.strip() or value != value.strip():
            errors.append("product.%s needs a non-empty name with no surrounding blank space" % key)
    retired = product.get("retired", [])
    if not isinstance(retired, list) or any(not isinstance(v, str) or not v.strip() for v in retired):
        errors.append("product.retired must list the names this product has had before, so a "
                      "half-finished rename fails instead of lingering")
    elif isinstance(product.get("name"), str) and product["name"] in retired:
        errors.append("product.name %r is also listed as retired" % product["name"])
    return errors


def product_module(tokens):
    """The JavaScript half of the declaration.

    `orchestrator/runtime/` is the replaceable workspace layer (spec 101) and ships without the
    desktop's build inputs, so the name arrives as content rather than as a path read at run time:
    a module cannot be half-read, and there is no fallback string in it to go stale."""
    product = tokens["product"]
    return "\n".join([
        "/* Generated by `python3 tools/design.py generate` from the product declaration in",
        " * orchestrator/native/theme.json. Edit the declaration, never this file (charter D41, spec 108). */",
        "export const PRODUCT_NAME = %s;" % json.dumps(product["name"]),
        "export const PRODUCT_FAMILY = %s;" % json.dumps(product["family"]),
    ]) + "\n"


# Which trees ship. docs/, Codex-progress.md, features.json and design/ are records or mirrors rather
# than shipping code, and rewriting a dated record to match today's name would falsify a log.
PRODUCT_ROOTS = ("orchestrator", "adapters", "tools", "scripts")
PRODUCT_SUFFIXES = (".c", ".h", ".m", ".mjs", ".js", ".py")
PRODUCT_SKIP = {"third_party", "node_modules", ".cache", ".git"}
# The two generated files, and the one test that pins the published name on purpose.
PRODUCT_ALLOWED = ("orchestrator/native/theme.h", "orchestrator/runtime/product.mjs",
                   "orchestrator/tests/product-name.test.mjs")


def uncommented(text, suffix):
    """Every part of a C, JavaScript or Python source that is not a comment, as (line, chunk) pairs:
    code runs, and the contents of quoted strings taken out of them.

    Comments are excluded deliberately — prose naming the product is not hard-coding it, and a file
    has to be able to say what it is. Everything else is in scope, including code outside strings:
    a regular expression matching the name is not a string literal, and a guard that read only
    string literals missed exactly one such match in native-identity.spec.mjs. A docstring is a
    string, so this file names the product nowhere but the declaration it reads."""
    py = suffix == ".py"
    i, n, line = 0, len(text), 1
    chunks, code, code_line = [], [], 1
    while i < n:
        char = text[i]
        if (py and char == "#") or (not py and text.startswith("//", i)):
            end = text.find("\n", i)
            i = n if end < 0 else end
        elif not py and text.startswith("/*", i):
            end = text.find("*/", i + 2)
            end = n if end < 0 else end + 2
            line += text.count("\n", i, end)
            i = end
        elif char in "\"'" or (not py and char == "`"):
            if code:
                chunks.append((code_line, "".join(code)))
                code = []
            quote = text[i:i + 3] if py and text[i:i + 3] in ('"""', "'''") else char
            multiline = len(quote) == 3 or quote == "`"
            start, j = line, i + len(quote)
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text.startswith(quote, j):
                    break
                if text[j] == "\n":
                    line += 1
                    if not multiline:
                        break          # an unterminated quote: read to the end of its line and move on
                j += 1
            chunks.append((start, text[i + len(quote):j]))
            i = j + len(quote) if j < n else n
            code_line = line
        else:
            if not code:
                code_line = line
            code.append(char)
            if char == "\n":
                line += 1
            i += 1
    if code:
        chunks.append((code_line, "".join(code)))
    return chunks


def product_literals(tokens, targets=None):
    """Fail when a shipping source spells the product name instead of reading the generated one.

    `targets` names files or directories to scan instead of the shipping roots, which is how a test
    can watch this go red for its own reason without writing a decoy into the tree other agents are
    working in."""
    product = tokens["product"]
    names = [product["name"], product["family"]] + list(product.get("retired", []))
    pattern = re.compile("(?<![A-Za-z0-9_])(%s)(?![A-Za-z0-9_])"
                         % "|".join(re.escape(name) for name in names))
    roots = targets if targets else [ROOT / name for name in PRODUCT_ROOTS if (ROOT / name).is_dir()]
    problems = []
    for root in roots:
        for path in ([root] if root.is_file() else sorted(root.rglob("*"))):
            if path.suffix not in PRODUCT_SUFFIXES or not path.is_file():
                continue
            try:
                shown = rel(path)
            except ValueError:
                shown = path.as_posix()
            if PRODUCT_SKIP & set(path.parts) or shown in PRODUCT_ALLOWED:
                continue
            hint = ("use RE_PRODUCT_NAME from theme.h" if path.suffix in (".c", ".h", ".m")
                    else "import PRODUCT_NAME from orchestrator/runtime/product.mjs")
            for start, chunk in uncommented(path.read_text(encoding="utf-8"), path.suffix):
                for match in pattern.finditer(chunk):
                    problems.append("%s:%d: hard-coded product name %r; %s (spec 108)"
                                    % (shown, start + chunk.count("\n", 0, match.start()),
                                       match.group(1), hint))
    return problems


def macro(*parts):
    return "_".join(part.upper().replace("-", "_") for part in parts)


def field(name):
    return name.replace("-", "_")


def preset_names(presets):
    return ["default"] + list(presets)


def bound_colors(tokens, resolved, preset):
    """Resolve every native colour binding in one preset, so a missing token fails generation."""
    out = {}
    for name, binding in tokens["colors"].items():
        entry = resolved.get("--" + binding["token"])
        if not entry or "rgba" not in entry:
            raise SystemExit("ERROR: theme.json: colour %r binds --%s, which %s does not resolve to a colour"
                             % (name, binding["token"], preset))
        out[name] = entry["rgba"]
    return out


def bound_metrics(tokens, resolved):
    out = {}
    for name, token in tokens.get("token-metrics", {}).items():
        entry = resolved.get("--" + token)
        value = re.fullmatch(r"(-?\d+(?:\.\d+)?)px", (entry or {}).get("value", "").strip()) if entry else None
        if not value:
            raise SystemExit("ERROR: theme.json: token metric %r binds --%s, which is not a pixel length" % (name, token))
        out[name] = int(round(float(value.group(1))))
    return out


ACCENT_HUE = "--re-accent-hue"
ACCENT_PROBE = "123.75"


def accent_recipe(tokens, layers, presets, name):
    """Which bound colours move with the accent hue, and the oklch recipe that re-tints them.

    A colour is accent-derived when re-resolving the preset with a different hue changes its text.
    That keeps the rule in the tokens rather than in a hand-kept list: a new token that reaches
    --re-accent-hue through any chain is picked up without touching this generator (spec 080).
    """
    base = resolve_preset(layers, presets, name)
    probe = resolve_preset(layers, presets, name, accent_hue=ACCENT_PROBE)
    hue = float(base[ACCENT_HUE]["value"])
    slots = []
    for index, binding in enumerate(tokens["colors"].values()):
        key = "--" + binding["token"]
        if base[key]["value"] == probe[key]["value"]:
            continue
        match = OKLCH.fullmatch(base[key]["value"].strip())
        if not match:
            raise SystemExit("ERROR: %s: %s follows the accent hue but is not a plain oklch() colour" % (name, key))
        lightness = float(match.group(1)[:-1]) / 100 if match.group(1).endswith("%") else float(match.group(1))
        slots.append((index, lightness, float(match.group(2)), alpha_byte(match.group(4))))
    accent = OKLCH.fullmatch(base["--re-accent"]["value"].strip())
    if not accent:
        raise SystemExit("ERROR: %s: --re-accent is not a plain oklch() colour" % name)
    lightness = float(accent.group(1)[:-1]) / 100 if accent.group(1).endswith("%") else float(accent.group(1))
    return hue, slots, (lightness, float(accent.group(2)))


def theme_sources(tokens, layers, presets):
    """theme.h declares the runtime theme and its macros; theme.c carries every preset (spec 076)."""
    names = preset_names(presets)
    tables = {name: bound_colors(tokens, resolve_preset(layers, presets, name), name) for name in names}
    metrics = bound_metrics(tokens, resolve_preset(layers, presets, "default"))
    fields = list(tokens["colors"])
    accents = {name: accent_recipe(tokens, layers, presets, name) for name in names}
    head = ["/* Generated by `python3 tools/design.py generate` from design/tokens.css and the bindings in",
            " * orchestrator/native/theme.json. Edit the tokens or the bindings, never this file. */"]
    h = head + ["#ifndef RENGINE_THEME_H", "#define RENGINE_THEME_H", "#include <stdint.h>", '#include "microui.h"',
                "/* The product's own name, declared in theme.json (charter D41, spec 108). Every C consumer",
                " * reads these; app.h's RE_DEFAULT_TITLE is an alias, never a second literal. */",
                "#define RE_PRODUCT_NAME %s" % json.dumps(tokens["product"]["name"]),
                "#define RE_PRODUCT_FAMILY %s" % json.dumps(tokens["product"]["family"]),
                "#define RE_THEME_FONT_SIZE %d" % tokens["typography"]["size"],
                "#define RE_THEME_LINE_HEIGHT %d" % tokens["typography"]["line-height"]]
    for group, values in tokens["metrics"].items():
        h += ["#define %s %d" % (macro("re-metric", group, key), value) for key, value in values.items()]
    h += ["#define %s %d" % (macro("re-metric", "design", key), value) for key, value in sorted(metrics.items())]
    h.append("typedef struct {")
    h += ["  mu_Color %s;" % field(name) for name in fields]
    h.append("} ReTheme;")
    h.append("enum { %s, RE_PRESET_COUNT = %d };" % (", ".join("%s = %d" % (macro("re-preset", name), i) for i, name in enumerate(names)), len(names)))
    h += ["extern ReTheme re_theme;                                   /* the live theme; presets assign it whole */",
          "extern int re_theme_preset;                                /* index of the live preset, for tables keyed by it */",
          "extern const ReTheme re_theme_presets[RE_PRESET_COUNT];",
          "extern const char *const re_theme_preset_names[RE_PRESET_COUNT];",
          "int re_theme_select(const char *name);                     /* preset index, or -1 when unknown */",
          "void re_theme_apply(mu_Style *style);                      /* pushes the live theme into microui's style */",
          "",
          "/* The accent hue is the one token a person can move at runtime (spec 080). Each preset lists the",
          " * colours that follow it with the oklch lightness, chroma and alpha to rebuild them at a new hue. */",
          "typedef struct { uint16_t index; float lightness, chroma; uint8_t alpha; } ReAccentSlot;",
          "#define RE_THEME_COLOR_COUNT %d" % len(fields),
          "extern const ReAccentSlot *const re_theme_accent_slots[RE_PRESET_COUNT];",
          "extern const int re_theme_accent_counts[RE_PRESET_COUNT];",
          "extern const float re_theme_accent_hues[RE_PRESET_COUNT];   /* each preset's own hue, in degrees */",
          "float re_theme_hue(void);                                  /* the live accent hue */",
          "void re_theme_hue_set(float hue);                          /* re-tints every accent-derived colour */",
          "mu_Color re_theme_swatch(float hue);                       /* --re-accent at a hue, for the slider track */",
          "mu_Color re_theme_from_oklch(float lightness, float chroma, float hue, unsigned char alpha);",
          "",
          "/* The token graph, one entry per token per preset, values left unexpanded so a theme file can",
          " * override a token in any of the three layers and everything below it follows (charter D34). */",
          "typedef struct { const char *name, *value; } ReToken;",
          "extern const ReToken *const re_theme_tokens[RE_PRESET_COUNT];",
          "extern const int re_theme_token_counts[RE_PRESET_COUNT];",
          "extern const char *const re_theme_field_tokens[RE_THEME_COLOR_COUNT];  /* the token each colour binds */"]
    h += ["#define %s re_theme.%s" % (macro("re-color", name), field(name)) for name in fields]
    h += ["#endif"]

    def table(values):
        """Brace initialisers, not mu_color(): these tables are file-scope constants."""
        return "{" + ", ".join("{%d, %d, %d, %d}" % tuple(values[name]) for name in fields) + "}"

    c = head + ['#include "theme.h"', "", "ReTheme re_theme = " + table(tables["default"]) + ";",
                "int re_theme_preset = RE_PRESET_DEFAULT;", "",
                "const ReTheme re_theme_presets[RE_PRESET_COUNT] = {"]
    c += ["  /* %s */ %s," % (name, table(tables[name])) for name in names]
    c += ["};", "const char *const re_theme_preset_names[RE_PRESET_COUNT] = {%s};" % ", ".join('"%s"' % n for n in names), ""]
    for name in names:
        values = {}
        for layer in LAYERS:
            values.update(layers[layer])
        if name != "default":
            values.update(presets[name])
        c.append("static const ReToken tokens_%s[] = {%s};" % (field(name),
                 ", ".join('{"%s", "%s"}' % (token, values[token].strip().replace('\\', '\\\\').replace('"', '\\"'))
                           for token in sorted(values))))
    c += ["const ReToken *const re_theme_tokens[RE_PRESET_COUNT] = {%s};" % ", ".join("tokens_%s" % field(name) for name in names),
          "const int re_theme_token_counts[RE_PRESET_COUNT] = {%s};"
          % ", ".join(str(len(set(list(layers["palette"]) + list(layers["semantic"]) + list(layers["views"]))
                              | set(presets.get(name, {})))) for name in names),
          "const char *const re_theme_field_tokens[RE_THEME_COLOR_COUNT] = {%s};"
          % ", ".join('"--%s"' % tokens["colors"][name_]["token"] for name_ in fields), ""]
    c += ["typedef char re_theme_is_a_colour_array[sizeof(ReTheme) == RE_THEME_COLOR_COUNT * sizeof(mu_Color) ? 1 : -1];", ""]
    for name in names:
        slots = accents[name][1]
        c.append("static const ReAccentSlot accent_%s[] = {%s};"
                 % (field(name), ", ".join("{%d, %.6ff, %.6ff, %d}" % slot for slot in slots) or "{0, 0, 0, 0}"))
    c += ["const ReAccentSlot *const re_theme_accent_slots[RE_PRESET_COUNT] = {%s};"
          % ", ".join("accent_%s" % field(name) for name in names),
          "const int re_theme_accent_counts[RE_PRESET_COUNT] = {%s};" % ", ".join(str(len(accents[name][1])) for name in names),
          "const float re_theme_accent_hues[RE_PRESET_COUNT] = {%s};" % ", ".join("%.6ff" % accents[name][0] for name in names),
          "static float re_theme_live_hue = %.6ff;" % accents[names[0]][0], "",
          "static const float re_theme_accent_lightness[RE_PRESET_COUNT] = {%s};" % ", ".join("%.6ff" % accents[name][2][0] for name in names),
          "static const float re_theme_accent_chroma[RE_PRESET_COUNT] = {%s};" % ", ".join("%.6ff" % accents[name][2][1] for name in names),
          "float re_theme_hue(void) { return re_theme_live_hue; }",
          "",
          "/* The same conversion tools/design.py uses to bake the tables, so a hue returned to its preset",
          " * value reproduces the generated colours exactly; that case restores the table rather than",
          " * recomputing, which keeps the snapshot gates stable. */",
          "static float re_theme_gamma(float x) {",
          "  if (x < 0) x = 0; if (x > 1) x = 1;",
          "  return x <= 0.0031308f ? 12.92f * x : 1.055f * powf(x, 1.0f / 2.4f) - 0.055f;",
          "}",
          "mu_Color re_theme_from_oklch(float lightness, float chroma, float hue, unsigned char alpha) {",
          "  float radians = hue * 3.14159265358979323846f / 180.0f;",
          "  float a = chroma * cosf(radians), b = chroma * sinf(radians);",
          "  float l = lightness + 0.3963377774f * a + 0.2158037573f * b;",
          "  float m = lightness - 0.1055613458f * a - 0.0638541728f * b;",
          "  float s = lightness - 0.0894841775f * a - 1.2914855480f * b;",
          "  l = l * l * l; m = m * m * m; s = s * s * s;",
          "  float red = 4.0767416621f * l - 3.3077115913f * m + 0.2309699292f * s;",
          "  float green = -1.2684380046f * l + 2.6097574011f * m - 0.3413193965f * s;",
          "  float blue = -0.0041960863f * l - 0.7034186147f * m + 1.7076147010f * s;",
          "  mu_Color c;",
          "  c.r = (unsigned char)(re_theme_gamma(red) * 255.0f + 0.5f);",
          "  c.g = (unsigned char)(re_theme_gamma(green) * 255.0f + 0.5f);",
          "  c.b = (unsigned char)(re_theme_gamma(blue) * 255.0f + 0.5f);",
          "  c.a = alpha;",
          "  return c;",
          "}",
          "mu_Color re_theme_swatch(float hue) {",
          "  return re_theme_from_oklch(re_theme_accent_lightness[re_theme_preset], re_theme_accent_chroma[re_theme_preset], hue, 255);",
          "}",
          "void re_theme_hue_set(float hue) {",
          "  while (hue < 0) hue += 360.0f;",
          "  while (hue >= 360.0f) hue -= 360.0f;",
          "  re_theme_live_hue = hue;",
          "  const ReAccentSlot *slots = re_theme_accent_slots[re_theme_preset];",
          "  int count = re_theme_accent_counts[re_theme_preset];",
          "  mu_Color *live = (mu_Color *)&re_theme;",
          "  const mu_Color *baked = (const mu_Color *)&re_theme_presets[re_theme_preset];",
          "  bool preset_hue = fabsf(hue - re_theme_accent_hues[re_theme_preset]) < 0.005f;",
          "  for (int i = 0; i < count; i++) {",
          "    live[slots[i].index] = preset_hue ? baked[slots[i].index]",
          "                                     : re_theme_from_oklch(slots[i].lightness, slots[i].chroma, hue, slots[i].alpha);",
          "  }",
          "}", "",
          "int re_theme_select(const char *name) {",
          "  for (int i = 0; i < RE_PRESET_COUNT; i++) {",
          "    if (name && !strcmp(name, re_theme_preset_names[i])) {",
          "      re_theme = re_theme_presets[i]; re_theme_preset = i;",
          "      re_theme_hue_set(re_theme_accent_hues[i]);   /* a preset carries its own hue (spec 080) */",
          "      return i;",
          "    }",
          "  }", "  return -1;", "}", "",
          "void re_theme_apply(mu_Style *style) {"]
    c += ["  style->colors[MU_COLOR_%s] = %s;" % (slot.upper(), macro("re-color", tokens["microui"][slot])) for slot in MICROUI]
    c += ["  style->%s = %s;" % (key.replace("-", "_"), macro("re-metric", "microui", key)) for key in MICROUI_METRICS[:-1]]
    c += ["  style->size.x = %s;" % macro("re-metric", "microui", "control-width"), "}"]
    c.insert(2, "#include <math.h>")
    c.insert(3, "#include <stdbool.h>")
    c.insert(4, "#include <string.h>")
    return "\n".join(h) + "\n", "\n".join(c) + "\n"


def theme_header(tokens):
    out = ["/* Generated by `python3 tools/design.py generate` from orchestrator/native/theme.json. Edit the tokens, not this file. */",
           "#ifndef RENGINE_THEME_H", "#define RENGINE_THEME_H", '#include "microui.h"',
           "#define RE_THEME_FONT_SIZE %d" % tokens["typography"]["size"],
           "#define RE_THEME_LINE_HEIGHT %d" % tokens["typography"]["line-height"]]
    out += ["#define %s mu_color(%d, %d, %d, %d)" % ((macro("re-color", name),) + tuple(color["rgba"]))
            for name, color in tokens["colors"].items()]
    for group, values in tokens["metrics"].items():
        out += ["#define %s %d" % (macro("re-metric", group, key), value) for key, value in values.items()]
    out.append("/* Applies the palette and microui metrics; the font pointer and size.y stay runtime values. */")
    out.append("static inline void re_theme_apply(mu_Style *style) {")
    out += ["  style->colors[MU_COLOR_%s] = %s;" % (slot.upper(), macro("re-color", tokens["microui"][slot])) for slot in MICROUI]
    out += ["  style->%s = %s;" % (key.replace("-", "_"), macro("re-metric", "microui", key)) for key in MICROUI_METRICS[:-1]]
    out += ["  style->size.x = %s;" % macro("re-metric", "microui", "control-width"), "}", "#endif"]
    return "\n".join(out) + "\n"


SYNTAX_KINDS = ["keyword", "type", "string", "number", "comment", "function", "preproc", "punct"]


def load_syntax():
    return json.loads(SYNTAX_JSON.read_text(encoding="utf-8"))


def syntax_header(doc, layers, presets):
    """Every scheme resolved against every theme preset: a palette that reads on dark does not on light,
    so a scheme may override per preset and the table carries both (spec 077 decision 3)."""
    names = preset_names(presets)
    schemes = list(doc["schemes"])
    resolved = {name: resolve_preset(layers, presets, name) for name in names}
    out = ["/* Generated by `python3 tools/design.py generate` from orchestrator/native/syntax.json and the",
           " * design tokens. Edit the schemes, not this file. */",
           "#ifndef RENGINE_SYNTAX_THEME_H", "#define RENGINE_SYNTAX_THEME_H", '#include "microui.h"',
           '#include "syntax.h"',
           "enum { %s, RE_SCHEME_COUNT = %d };" % (", ".join("%s = %d" % (macro("re-scheme", s), i) for i, s in enumerate(schemes)), len(schemes)),
           "static const char *const re_scheme_names[RE_SCHEME_COUNT] = {%s};" % ", ".join('"%s"' % s for s in schemes),
           "static const char *const re_scheme_titles[RE_SCHEME_COUNT] = {%s};" % ", ".join('"%s"' % doc["schemes"][s]["title"] for s in schemes),
           "/* [scheme][theme preset][token role] */",
           "static const mu_Color re_scheme_colors[RE_SCHEME_COUNT][RE_PRESET_COUNT][RE_SYNTAX_COUNT] = {"]
    for scheme in schemes:
        entry = doc["schemes"][scheme]
        out.append("  { /* %s */" % scheme)
        for preset in names:
            values = dict(entry["kinds"])
            values.update(entry.get("presets", {}).get(preset, {}))
            colors = []
            for kind in ["text"] + SYNTAX_KINDS:
                if kind == "text":
                    colors.append("{0, 0, 0, 0}")   # unclaimed bytes keep the editor's foreground
                    continue
                text = values[kind]
                while True:
                    match = VAR.search(text)
                    if not match:
                        break
                    token = resolved[preset].get(match.group(1))
                    if not token:
                        raise SystemExit("ERROR: syntax.json: %s/%s references undefined %s" % (scheme, kind, match.group(1)))
                    text = text[:match.start()] + token["value"] + text[match.end():]
                rgba = parse_css_color(text)
                if not rgba:
                    raise SystemExit("ERROR: syntax.json: %s/%s is not a colour (%s)" % (scheme, kind, text))
                colors.append("{%d, %d, %d, %d}" % tuple(rgba))
            out.append("    { %s }, /* %s */" % (", ".join(colors), preset))
        out.append("  },")
    out += ["};", "#endif"]
    return "\n".join(out) + "\n"


def load_icons():
    doc = json.loads(ICONS_JSON.read_text(encoding="utf-8"))
    return doc["font"], doc["icons"]


def icons_header(font, icons):
    """Named icons and their codepoints in the pinned icon face (spec 076 decision 5)."""
    out = ["/* Generated by `python3 tools/design.py generate` from orchestrator/native/icons.json. Edit the mapping, not this file. */",
           "#ifndef RENGINE_ICONS_H", "#define RENGINE_ICONS_H", "#include <stdint.h>",
           "/* Face: %s %s (%s) */" % (font["family"], font["version"], font["source"]), "enum {"]
    out += ["  %s = %d," % (macro("re-icon", icon["name"]), index) for index, icon in enumerate(icons)]
    out += ["  RE_ICON_COUNT = %d" % len(icons), "};",
            "static const uint32_t re_icon_codepoints[RE_ICON_COUNT] = {"]
    out += ["  %s, /* %s%s */" % (icon["codepoint"], icon["phosphor"],
            (" — " + " ".join(icon["symbols"])) if icon["symbols"] else "") for icon in icons]
    out += ["};", "#endif"]
    return "\n".join(out) + "\n"


def icon_coverage(icons):
    """Every icon symbol a card draws must be claimed by an entry, so a new card cannot ship unmapped."""
    claimed = {symbol for icon in icons for symbol in icon["symbols"]}
    problems = []
    for path in sorted(PREVIEWS.rglob("*.html")):
        for symbol in ICON_SPAN.findall(path.read_text(encoding="utf-8")):
            symbol = symbol.strip()
            if symbol and symbol not in claimed:
                problems.append("%s: card icon %r has no entry in %s" % (rel(path), symbol, rel(ICONS_JSON)))
    return sorted(set(problems))


SURFACES = {
    "toolbar": {"height": "toolbar-height", "background": "toolbar-bg", "brand": "ui-accent"},
    "tabs": {"height": "tabs-height", "background": "tabs-bg", "active": "tab-active-bg", "marker": "tab-marker"},
    "status": {"height": "status-height", "background": "status-bg", "accent": "status-accent-bg"},
    "pane": {"background": "pane-bg", "divider": "pane-divider"},
    "tree": {"height": "tree-row", "background": "tree-bg", "selected": "tree-selected-bg", "icon": "tree-icon"},
    "terminal": {"background": "terminal-bg", "foreground": "terminal-fg", "cursor": "terminal-cursor"},
    "editor": {"background": "editor-bg", "gutter": "editor-gutter-fg", "caret": "editor-caret"},
    # The menus card: one raised ground, accent hover, soft separators (spec 080).
    "popover": {"height": "ui-row", "background": "ui-surface-raised", "hover": "ui-accent",
                "hoverInk": "ui-fg-on-accent", "separator": "ui-border-soft", "hint": "ui-fg-faint"},
}


def card_reference(layers, presets):
    """Geometry and resolved colours the native surfaces must match, taken from the tokens rather
    than hand-copied from a card (spec 076 decision 3)."""
    names = preset_names(presets)
    out = {"version": 1, "note": "Generated by `python3 tools/design.py cards`. orchestrator/tests/native-design.spec.mjs"
                                 " asserts these against native snapshots; regenerate when tokens.css changes.",
           "presets": {}}
    syntax = load_syntax()
    for name in names:
        resolved = resolve_preset(layers, presets, name)
        surfaces = {}
        for surface, fields in SURFACES.items():
            entry = {}
            for field, token in fields.items():
                value = resolved.get("--" + token)
                if not value:
                    raise SystemExit("ERROR: card reference: --%s is undefined" % token)
                if field == "height":
                    pixels = re.fullmatch(r"(\d+)px", value["value"].strip())
                    if not pixels:
                        raise SystemExit("ERROR: card reference: --%s is not a pixel height" % token)
                    entry[field] = int(pixels.group(1))
                elif "rgba" in value:
                    entry[field] = "#%02x%02x%02x" % tuple(value["rgba"][:3])
                else:
                    raise SystemExit("ERROR: card reference: --%s does not resolve to a colour" % token)
            surfaces[surface] = entry
        scheme = syntax["schemes"][syntax["default"]]
        values = dict(scheme["kinds"]); values.update(scheme.get("presets", {}).get(name, {}))
        colours = {}
        for kind in ("keyword", "string", "comment", "number", "function"):
            text = values[kind]
            while True:
                match = VAR.search(text)
                if not match:
                    break
                text = text[:match.start()] + resolved[match.group(1)]["value"] + text[match.end():]
            colours[kind] = "#%02x%02x%02x" % tuple(parse_css_color(text)[:3])
        surfaces["syntax"] = colours
        out["presets"][name] = surfaces
    return json.dumps(out, indent=2, ensure_ascii=False) + "\n"


# ---- design tokens (tokens.css, three :root layers plus [data-theme] presets) --------------------

def parse_tokens_css():
    text = COMMENT.sub("", TOKENS_CSS.read_text(encoding="utf-8"))
    layers, presets, roots = {}, {}, 0
    for match in BLOCK.finditer(text):
        selector, theme, body = match.groups()
        declarations = {key: value.strip() for key, value in DECLARATION.findall(body)}
        if selector == ":root":
            if roots < len(LAYERS):
                layers[LAYERS[roots]] = declarations
            roots += 1
        else:
            presets[theme] = declarations
    if roots != len(LAYERS):
        raise SystemExit("ERROR: tokens.css must contain exactly three :root blocks (palette, semantic, views); found %d" % roots)
    return layers, presets


def mirror_tokens(layers, presets):
    current = json.loads(TOKENS_JSON.read_text(encoding="utf-8")) if TOKENS_JSON.exists() else {}
    mirrored = {"version": 2}
    for key in ("name", "source"):
        if key in current:
            mirrored[key] = current[key]
    layer_json = current.get("layers", {})
    mirrored["layers"] = {name: {**{k: v for k, v in layer_json.get(name, {}).items() if k != "tokens"}, "tokens": layers[name]}
                          for name in LAYERS}
    mirrored["presets"] = {"default": {}, **presets}
    for key, value in current.items():
        if key not in mirrored:
            mirrored[key] = value
    return json.dumps(mirrored, indent=2, ensure_ascii=False) + "\n"


def oklch_to_rgb(lightness, chroma, hue):
    a, b = chroma * math.cos(math.radians(hue)), chroma * math.sin(math.radians(hue))
    l_ = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3
    linear = (4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
              -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
              -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_)
    def gamma(x):
        x = min(1.0, max(0.0, x))
        return 12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055
    return [round(gamma(v) * 255) for v in linear]


def alpha_byte(text):
    if text is None:
        return 255
    return round(float(text[:-1]) * 2.55) if text.endswith("%") else round(float(text) * 255)


def parse_css_color(value):
    value = value.strip()
    if value == "transparent":
        return [0, 0, 0, 0]
    match = HEX.fullmatch(value)
    if match:
        digits = match.group(1)
        if len(digits) <= 4:
            digits = "".join(d * 2 for d in digits)
        rgba = [int(digits[i:i + 2], 16) for i in range(0, len(digits), 2)]
        return rgba if len(rgba) == 4 else rgba + [255]
    match = RGB.fullmatch(value)
    if match:
        return [int(match.group(1)), int(match.group(2)), int(match.group(3)), alpha_byte(match.group(4))]
    match = OKLCH.fullmatch(value)
    if match:
        lightness = float(match.group(1)[:-1]) / 100 if match.group(1).endswith("%") else float(match.group(1))
        return oklch_to_rgb(lightness, float(match.group(2)), float(match.group(3))) + [alpha_byte(match.group(4))]
    return None


def resolve_preset(layers, presets, name, accent_hue=None):
    values = {}
    for layer in LAYERS:
        values.update(layers[layer])
    if name != "default":
        if name not in presets:
            raise SystemExit("ERROR: unknown preset %r; presets: default, %s" % (name, ", ".join(presets)))
        values.update(presets[name])
    if accent_hue is not None:
        values[ACCENT_HUE] = accent_hue

    def expand(token, stack):
        if token not in values:
            raise SystemExit("ERROR: %s references undefined %s" % (stack[-1] if stack else "preset", token))
        if token in stack:
            raise SystemExit("ERROR: token cycle through %s" % token)
        return VAR.sub(lambda m: expand(m.group(1), stack + (token,)), values[token])

    resolved = {}
    for token in values:
        text = expand(token, ())
        color = parse_css_color(text)
        resolved[token] = {"value": text, "rgba": color} if color else {"value": text}
    return resolved


# ---- cards ------------------------------------------------------------------------------------

def collect_cards():
    cards, problems = [], []
    for path in sorted(PREVIEWS.rglob("*.html")):
        relative = path.relative_to(DESIGN).as_posix()
        text = path.read_text(encoding="utf-8")
        match = CARD.match(text.split("\n", 1)[0])
        attrs = dict(ATTR.findall(match.group(1))) if match else {}
        if "group" not in attrs or "name" not in attrs:
            problems.append('%s: first line must be <!-- @dsCard group="…" name="…" … -->' % relative)
            continue
        expected = "../" * (len(path.relative_to(DESIGN).parts) - 1) + "styles.css"
        links = LINK.findall(text)
        if links != [expected]:
            problems.append("%s: needs exactly one stylesheet link to %s (found %s)" % (relative, expected, links or "none"))
        if EXTERNAL.search(text):
            problems.append("%s: previews must be self-contained; remove external URLs" % relative)
        if len(text.encode("utf-8")) > 256 * 1024:
            problems.append("%s: exceeds the 256 KiB sync limit" % relative)
        card = {"path": relative, "name": attrs["name"], "group": attrs["group"]}
        if attrs.get("subtitle"):
            card["subtitle"] = attrs["subtitle"]
        size = re.fullmatch(r"(\d+)x(\d+)", attrs.get("viewport", ""))
        viewport = {"width": int(size.group(1)), "height": int(size.group(2))} if size else \
            {key: int(attrs[key]) for key in ("width", "height") if attrs.get(key, "").isdigit()}
        if viewport:
            card["viewport"] = viewport
        cards.append(card)
    return cards, problems


def manifest_text(cards):
    return json.dumps({"version": 1, "cards": cards}, indent=2, ensure_ascii=False) + "\n"


def stylesheet_problems():
    problems = []
    text = STYLES_CSS.read_text(encoding="utf-8") if STYLES_CSS.exists() else ""
    for name in ("tokens.css", "base.css"):
        if '@import url("%s");' % name not in text:
            problems.append("design/styles.css must import %s" % name)
        if not (DESIGN / name).exists():
            problems.append("design/%s is missing" % name)
    return problems


# ---- native guards ------------------------------------------------------------------------------

def native_literals(tokens):
    problems = []
    for path in sorted(NATIVE.glob("*.c")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for match in LITERAL.finditer(line):
                groups = match.groups()
                rgba = [int(v) for v in groups[:4]] if groups[0] is not None else [int(v) for v in groups[4:]] + [255]
                names = [name for name, color in tokens["colors"].items() if color["rgba"] == rgba]
                hint = "use RE_COLOR_%s" % macro(names[0]) if names else "add a token to theme.json and use its RE_COLOR_* constant"
                problems.append("%s:%d: hard-coded colour %s; %s" % (rel(path), number, rgba, hint))
    return problems


def native_layout_rows():
    problems = []
    for path in sorted(NATIVE.glob("*.c")):
        text = path.read_text(encoding="utf-8")
        for match in LAYOUT_ROW.finditer(text):
            values = [v.strip() for v in match.group(1).split(",")] + [match.group(2).strip()]
            literal = [v for v in values if re.fullmatch(r"-?\d+", v) and v != "-1"]
            if literal:
                line = text.count("\n", 0, match.start()) + 1
                problems.append("%s:%d: layout row uses literal %s; use RE_METRIC_* from theme.h" % (rel(path), line, ", ".join(literal)))
    return problems


GENERATED_CMAKE = ("CMakeLists.txt", "adapters/sdl2/CMakeLists.txt")


def native_build_files():
    problems = []
    for name in GENERATED_CMAKE:
        path = ROOT / name
        first = path.read_text(encoding="utf-8").split("\n", 1)[0] if path.exists() else ""
        if not first.startswith("# This file is automatically generated from cmake.toml"):
            problems.append("%s must be generated from cmake.toml by cmkr, not written by hand" % name)
    if (NATIVE / "CMakeLists.txt").exists():
        problems.append("orchestrator/native/CMakeLists.txt is obsolete; targets live in the root cmake.toml")
    return problems


def native_render_layering():
    problems = []
    for path in sorted(list(NATIVE.rglob("*.c")) + list(NATIVE.rglob("*.h")) + list(NATIVE.rglob("*.m"))):
        if path.parent.name == "render" and path.name.startswith("backend_") and path.suffix in (".c", ".m"):
            continue
        # The GPU device layer is below the draw list by construction (spec 122): it is the piece a
        # backend and an OpenXR host both build on, so it holds Vulkan symbols for the same reason a
        # backend does. What it may NOT hold is windowing, which native_gpu_device_layer checks.
        if path.stem == "gpu_device":
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            match = RENDER_API.search(line)
            if match:
                problems.append("%s:%d: %s belongs below the draw list (render/backend_*.c or .m only)" % (rel(path), number, match.group(0)))
    return problems


GPU_DEVICE_WINDOWING = re.compile(r"SDL_|VkSurface|vkCreateSurface|Swapchain|SWAPCHAIN|vkQueuePresent|PresentKHR")


GPU_SEAM_LINKED_API = re.compile(r"#\s*include\s*[<\"](?:GL|GLES|OpenGL|glad|SDL|vulkan)")


def native_gpu_device_layer():
    """Neither pack layer may grow a dependency it exists to avoid (charter D49/D52, spec 122).

    The DEVICE layer must stay usable by a host that has no window. OpenXR dictates instance and
    device creation and then hands the application its swapchain images, so a device layer that
    reaches for a surface or a swapchain cannot serve a headset at all. That is the whole reason the
    layer exists, and it is one grep away from being lost, so it is a gate rather than a review note.

    The SEAM must link no graphics library. Its entry points come from the host's own loader, which
    is what lets a consumer keep the loader it already links — vtmb-vr links glad, and two glad
    implementations in one binary is a symbol clash rather than a dependency. Including a GL header
    is how that would be lost, silently, because it would keep building here."""
    problems = []
    root = NATIVE.parent.parent / "packs" / "gpu"
    for path in (root / "src" / "gpu_device.c", root / "include" / "rengine" / "gpu_device.h"):
        if not path.exists():
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if line.lstrip().startswith(("*", "/*", "//")):
                continue  # prose may name what the layer refuses to depend on
            match = GPU_DEVICE_WINDOWING.search(line)
            if match:
                problems.append("%s:%d: %s is windowing; the GPU device layer must stay usable "
                                "without a window (spec 122)" % (rel(path), number, match.group(0)))
    seam = [root / "include" / "rengine" / "gpu_seam.h", root / "include" / "rengine" / "gpu_seam.hpp"]
    seam += sorted((root / "src").glob("gpu_seam_*.c"))
    for path in seam:
        if not path.exists():
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if line.lstrip().startswith(("*", "/*", "//")):
                continue
            match = GPU_SEAM_LINKED_API.search(line)
            if match:
                problems.append("%s:%d: %s links a graphics API into the pack; the seam takes its "
                                "entry points from the host's loader so a consumer can keep its own "
                                "(spec 122)" % (rel(path), number, match.group(0)))
            windowing = re.search(r"SDL_", line)
            if windowing:
                problems.append("%s:%d: SDL_ is windowing; the seam draws into whatever target the "
                                "host bound and never makes one (spec 122)" % (rel(path), number))
    return problems


# ---- commands -----------------------------------------------------------------------------------

def generate():
    tokens = load_native_theme()
    layers, presets = parse_tokens_css()
    header, source = theme_sources(tokens, layers, presets)
    THEME_H.write_text(header, encoding="utf-8")
    THEME_C.write_text(source, encoding="utf-8")
    PRODUCT_MJS.write_text(product_module(tokens), encoding="utf-8")
    font, icons = load_icons()
    ICONS_H.write_text(icons_header(font, icons), encoding="utf-8")
    SYNTAX_H.write_text(syntax_header(load_syntax(), layers, presets), encoding="utf-8")
    TOKENS_JSON.write_text(mirror_tokens(layers, presets), encoding="utf-8")
    CARDS_JSON.write_text(card_reference(layers, presets), encoding="utf-8")
    cards, problems = collect_cards()
    MANIFEST.write_text(manifest_text(cards), encoding="utf-8")
    problems += stylesheet_problems()
    for problem in problems:
        print("ERROR: " + problem)
    print("Generated theme.h and theme.c, runtime/product.mjs, render/icons.h (%d icons), render/syntax_theme.h (%d schemes), the tokens.json mirror, cards.json and manifest.json for %d cards (%d presets: default, %s)."
          % (len(icons), len(load_syntax()["schemes"]), len(cards), len(presets) + 1, ", ".join(presets)))
    return 1 if problems else 0


def check():
    tokens = load_native_theme()
    layers, presets = parse_tokens_css()
    problems = []

    def compare(path, expected):
        if not path.exists() or path.read_text(encoding="utf-8") != expected:
            problems.append("%s is stale or missing (run generate)" % rel(path))

    header, source = theme_sources(tokens, layers, presets)
    compare(THEME_H, header)
    compare(THEME_C, source)
    compare(PRODUCT_MJS, product_module(tokens))
    font, icons = load_icons()
    compare(ICONS_H, icons_header(font, icons))
    compare(SYNTAX_H, syntax_header(load_syntax(), layers, presets))
    problems += icon_coverage(icons)
    compare(TOKENS_JSON, mirror_tokens(layers, presets))
    compare(CARDS_JSON, card_reference(layers, presets))
    cards, card_problems = collect_cards()
    problems += card_problems + stylesheet_problems()
    compare(MANIFEST, manifest_text(cards))
    for name in ["default"] + list(presets):
        resolve_preset(layers, presets, name)
    problems += native_literals(tokens) + native_layout_rows() + native_render_layering() + native_build_files()
    problems += native_gpu_device_layer()
    problems += product_literals(tokens)
    for problem in problems:
        print("ERROR: " + problem)
    if problems:
        return 1
    print("Native theme, %d design cards, the token mirror and %d presets are consistent; native sources use theme constants only, and the product name is read rather than typed."
          % (len(cards), len(presets) + 1))
    return 0


def product(target=None):
    """The name guard on its own, so a suite can assert it without inheriting an unrelated failure."""
    tokens = load_native_theme()
    problems = product_literals(tokens, [Path(target).resolve()] if target else None)
    print(json.dumps({"name": tokens["product"]["name"], "family": tokens["product"]["family"],
                      "retired": list(tokens["product"].get("retired", [])),
                      "generated": ["orchestrator/native/theme.h", "orchestrator/runtime/product.mjs"],
                      "problems": problems}, indent=2, ensure_ascii=False))
    return 1 if problems else 0


def resolve(name):
    layers, presets = parse_tokens_css()
    print(json.dumps({"preset": name, "tokens": resolve_preset(layers, presets, name)}, indent=2, ensure_ascii=False))
    return 0


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command == "generate" and len(argv) == 2:
        return generate()
    if command == "check" and len(argv) == 2:
        return check()
    if command == "product" and len(argv) in (2, 3):
        return product(argv[2] if len(argv) == 3 else None)
    if command == "resolve" and len(argv) in (2, 3):
        return resolve(argv[2] if len(argv) == 3 else "default")
    print(__doc__.strip())
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

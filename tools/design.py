#!/usr/bin/env python3
"""Bridge the desktop's theme source and the Claude Design system project.

  generate            write orchestrator/native/theme.h from orchestrator/native/theme.json, refresh the
                      design/tokens.json mirror from design/tokens.css and design/manifest.json from the cards
  check               fail when generated output is stale, a card is malformed or not self-contained, the
                      token mirror drifts, a native source hard-codes a colour or layout row size, or a
                      file above the draw list uses graphics-API rendering symbols, or a CMakeLists.txt
                      was written by hand instead of generated from cmake.toml
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
    if errors:
        raise SystemExit("\n".join("ERROR: theme.json: " + e for e in errors))
    return tokens


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


def theme_sources(tokens, layers, presets):
    """theme.h declares the runtime theme and its macros; theme.c carries every preset (spec 076)."""
    names = preset_names(presets)
    tables = {name: bound_colors(tokens, resolve_preset(layers, presets, name), name) for name in names}
    metrics = bound_metrics(tokens, resolve_preset(layers, presets, "default"))
    fields = list(tokens["colors"])
    head = ["/* Generated by `python3 tools/design.py generate` from design/tokens.css and the bindings in",
            " * orchestrator/native/theme.json. Edit the tokens or the bindings, never this file. */"]
    h = head + ["#ifndef RENGINE_THEME_H", "#define RENGINE_THEME_H", '#include "microui.h"',
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
          "extern const ReTheme re_theme_presets[RE_PRESET_COUNT];",
          "extern const char *const re_theme_preset_names[RE_PRESET_COUNT];",
          "int re_theme_select(const char *name);                     /* preset index, or -1 when unknown */",
          "void re_theme_apply(mu_Style *style);                      /* pushes the live theme into microui's style */"]
    h += ["#define %s re_theme.%s" % (macro("re-color", name), field(name)) for name in fields]
    h += ["#endif"]

    def table(values):
        """Brace initialisers, not mu_color(): these tables are file-scope constants."""
        return "{" + ", ".join("{%d, %d, %d, %d}" % tuple(values[name]) for name in fields) + "}"

    c = head + ['#include "theme.h"', "", "ReTheme re_theme = " + table(tables["default"]) + ";", "",
                "const ReTheme re_theme_presets[RE_PRESET_COUNT] = {"]
    c += ["  /* %s */ %s," % (name, table(tables[name])) for name in names]
    c += ["};", "const char *const re_theme_preset_names[RE_PRESET_COUNT] = {%s};" % ", ".join('"%s"' % n for n in names), "",
          "int re_theme_select(const char *name) {",
          "  for (int i = 0; i < RE_PRESET_COUNT; i++) {",
          "    if (name && !strcmp(name, re_theme_preset_names[i])) { re_theme = re_theme_presets[i]; return i; }",
          "  }", "  return -1;", "}", "",
          "void re_theme_apply(mu_Style *style) {"]
    c += ["  style->colors[MU_COLOR_%s] = %s;" % (slot.upper(), macro("re-color", tokens["microui"][slot])) for slot in MICROUI]
    c += ["  style->%s = %s;" % (key.replace("-", "_"), macro("re-metric", "microui", key)) for key in MICROUI_METRICS[:-1]]
    c += ["  style->size.x = %s;" % macro("re-metric", "microui", "control-width"), "}"]
    c.insert(2, "#include <string.h>")
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
}


def card_reference(layers, presets):
    """Geometry and resolved colours the native surfaces must match, taken from the tokens rather
    than hand-copied from a card (spec 076 decision 3)."""
    names = preset_names(presets)
    out = {"version": 1, "note": "Generated by `python3 tools/design.py cards`. orchestrator/tests/native-design.spec.mjs"
                                 " asserts these against native snapshots; regenerate when tokens.css changes.",
           "presets": {}}
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


def resolve_preset(layers, presets, name):
    values = {}
    for layer in LAYERS:
        values.update(layers[layer])
    if name != "default":
        if name not in presets:
            raise SystemExit("ERROR: unknown preset %r; presets: default, %s" % (name, ", ".join(presets)))
        values.update(presets[name])

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
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            match = RENDER_API.search(line)
            if match:
                problems.append("%s:%d: %s belongs below the draw list (render/backend_*.c or .m only)" % (rel(path), number, match.group(0)))
    return problems


# ---- commands -----------------------------------------------------------------------------------

def generate():
    tokens = load_native_theme()
    layers, presets = parse_tokens_css()
    header, source = theme_sources(tokens, layers, presets)
    THEME_H.write_text(header, encoding="utf-8")
    THEME_C.write_text(source, encoding="utf-8")
    font, icons = load_icons()
    ICONS_H.write_text(icons_header(font, icons), encoding="utf-8")
    TOKENS_JSON.write_text(mirror_tokens(layers, presets), encoding="utf-8")
    CARDS_JSON.write_text(card_reference(layers, presets), encoding="utf-8")
    cards, problems = collect_cards()
    MANIFEST.write_text(manifest_text(cards), encoding="utf-8")
    problems += stylesheet_problems()
    for problem in problems:
        print("ERROR: " + problem)
    print("Generated theme.h and theme.c, render/icons.h (%d icons), the tokens.json mirror, cards.json and manifest.json for %d cards (%d presets: default, %s)."
          % (len(icons), len(cards), len(presets) + 1, ", ".join(presets)))
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
    font, icons = load_icons()
    compare(ICONS_H, icons_header(font, icons))
    problems += icon_coverage(icons)
    compare(TOKENS_JSON, mirror_tokens(layers, presets))
    compare(CARDS_JSON, card_reference(layers, presets))
    cards, card_problems = collect_cards()
    problems += card_problems + stylesheet_problems()
    compare(MANIFEST, manifest_text(cards))
    for name in ["default"] + list(presets):
        resolve_preset(layers, presets, name)
    problems += native_literals(tokens) + native_layout_rows() + native_render_layering() + native_build_files()
    for problem in problems:
        print("ERROR: " + problem)
    if problems:
        return 1
    print("Native theme, %d design cards, the token mirror and %d presets are consistent; native sources use theme constants only."
          % (len(cards), len(presets) + 1))
    return 0


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
    if command == "resolve" and len(argv) in (2, 3):
        return resolve(argv[2] if len(argv) == 3 else "default")
    print(__doc__.strip())
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

#!/usr/bin/env python3
"""Bridge design/tokens.json to the native theme header and the Claude Design preview library.

  generate        write orchestrator/native/theme.h, design/tokens.css and design/manifest.json, and
                  refresh the managed blocks inside design/previews/**/*.html
  check           fail when a generated artifact, a preview block or a native colour literal drifts
  import FILE...  apply token values from a preview's :root block (for example a card pulled back
                  from Claude Design) to tokens.json, then regenerate

Boundaries and rationale: docs/specs/063-design-system-handoff.md. Standard library only.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESIGN = ROOT / "design"
TOKENS = DESIGN / "tokens.json"
BASE_CSS = DESIGN / "base.css"
TOKENS_CSS = DESIGN / "tokens.css"
MANIFEST = DESIGN / "manifest.json"
PREVIEWS = DESIGN / "previews"
NATIVE = ROOT / "orchestrator" / "native"
THEME_H = NATIVE / "theme.h"
MICROUI = ["text", "border", "windowbg", "titlebg", "titletext", "panelbg", "button", "buttonhover",
           "buttonfocus", "base", "basehover", "basefocus", "scrollbase", "scrollthumb"]
MICROUI_METRICS = ["padding", "spacing", "indent", "title-height", "scrollbar-size", "thumb-size", "control-width"]
REQUIRED_BLOCKS = ("tokens", "base")
OPTIONAL_BLOCKS = ("palette", "metrics")
NAME = re.compile(r"[a-z][a-z0-9-]*")
CARD = re.compile(r'^<!-- @dsCard((?:\s+[a-z]+="[^"]*")+)\s*-->\s*$')
ATTR = re.compile(r'([a-z]+)="([^"]*)"')
LITERAL = re.compile(r"mu_color\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)"
                     r"|vterm_color_rgb\(\s*&\w+\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)")
DECLARATION = re.compile(r"--re-(color|metric|font-size|line-height)(?:-([a-z0-9-]+))?\s*:\s*([^;]+);")
COLOR = re.compile(r"rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)\s*(?:[,/]\s*([0-9.]+%?))?\s*\)")
EXTERNAL = re.compile(r"""(?:src|href)\s*=\s*["']?\s*(?:https?:)?//|@import|url\(\s*["']?\s*(?:https?:)?//""")


def is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def load_tokens():
    tokens = json.loads(TOKENS.read_text(encoding="utf-8"))
    errors = []
    colors = tokens.get("colors", {})
    for name, color in colors.items():
        rgba = color.get("rgba") if isinstance(color, dict) else None
        if not NAME.fullmatch(name) or not isinstance(rgba, list) or len(rgba) != 4 \
                or any(not is_int(v) or v < 0 or v > 255 for v in rgba):
            errors.append("colour %r needs an rgba list of four integers 0-255" % name)
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
    if not isinstance(typography.get("family"), list) or not typography["family"]:
        errors.append("typography.family needs a non-empty list")
    if errors:
        raise SystemExit("\n".join("ERROR: tokens.json: " + e for e in errors))
    return tokens


def dump_tokens(tokens):
    text = json.dumps(tokens, indent=2, ensure_ascii=False)
    scalar = r'(?:"[^"\n]*"|-?\d+)'
    return re.sub(r"\[\s*(%s(?:,\s*%s)*)\s*\]" % (scalar, scalar),
                  lambda m: "[" + re.sub(r",\s*", ", ", m.group(1)) + "]", text) + "\n"


def css_color(rgba):
    r, g, b, a = rgba
    return "rgb(%d, %d, %d)" % (r, g, b) if a == 255 else "rgba(%d, %d, %d, %.3f)" % (r, g, b, a / 255)


def css_metric(key, value):
    return "%d" % value if key.endswith("characters") else "%dpx" % value


def tokens_css(tokens):
    typography = tokens["typography"]
    family = ", ".join(f if re.fullmatch(r"[a-z-]+", f) else '"%s"' % f for f in typography["family"])
    lines = [":root {", "  --re-font-family: %s;" % family, "  --re-font-size: %dpx;" % typography["size"],
             "  --re-line-height: %dpx;" % typography["line-height"]]
    lines += ["  --re-color-%s: %s;" % (name, css_color(color["rgba"])) for name, color in tokens["colors"].items()]
    for group, values in tokens["metrics"].items():
        lines += ["  --re-metric-%s-%s: %s;" % (group, key, css_metric(key, value)) for key, value in values.items()]
    return "\n".join(lines + ["}"]) + "\n"


def macro(*parts):
    return "_".join(part.upper().replace("-", "_") for part in parts)


def theme_header(tokens):
    out = ["/* Generated by `python3 tools/design.py generate` from design/tokens.json. Edit the tokens, not this file. */",
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


def escape(text):
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def palette_html(tokens):
    rows = []
    for name, color in tokens["colors"].items():
        rows.append('<div class="re-swatch"><div class="chip" style="background: var(--re-color-%s)"></div>'
                    '<div class="meta"><b>%s</b> <code>--re-color-%s</code> · %s<br><span class="re-note">%s%s</span></div></div>'
                    % (name, name, name, css_color(color["rgba"]), escape(color.get("role", "")),
                       " · native: " + escape(color["native"]) if color.get("native") else ""))
    return '<div class="re-palette">\n' + "\n".join(rows) + "\n</div>\n"


def metrics_html(tokens):
    notes = tokens.get("metric-notes", {})
    rows = []
    for group, values in tokens["metrics"].items():
        cells = ", ".join("%s <b>%s</b>" % (key, css_metric(key, value)) for key, value in values.items())
        rows.append("<tr><th>%s</th><td>%s<br><span class=\"re-note\">%s</span></td></tr>" % (group, cells, escape(notes.get(group, ""))))
    return '<table class="re-metrics">\n' + "\n".join(rows) + "\n</table>\n"


def blocks_for(tokens):
    return {"tokens": "<style id=\"re-tokens\">\n%s</style>" % tokens_css(tokens),
            "base": "<style id=\"re-base\">\n%s</style>" % BASE_CSS.read_text(encoding="utf-8"),
            "palette": palette_html(tokens), "metrics": metrics_html(tokens)}


def render_preview(text, blocks):
    for name in REQUIRED_BLOCKS + OPTIONAL_BLOCKS:
        pattern = re.compile(r"<!-- re:%s -->.*?<!-- /re:%s -->" % (name, name), re.S)
        count = len(pattern.findall(text))
        if count > 1 or (count == 0 and name in REQUIRED_BLOCKS):
            return None
        text = pattern.sub(lambda _: "<!-- re:%s -->\n%s\n<!-- /re:%s -->" % (name, blocks[name].rstrip("\n"), name), text)
    return text


def collect_cards(blocks, write):
    cards, problems = [], []
    for path in sorted(PREVIEWS.rglob("*.html")):
        rel = path.relative_to(DESIGN).as_posix()
        text = path.read_text(encoding="utf-8")
        match = CARD.match(text.split("\n", 1)[0])
        attrs = dict(ATTR.findall(match.group(1))) if match else {}
        if "group" not in attrs or "name" not in attrs:
            problems.append('%s: first line must be <!-- @dsCard group="…" name="…" … -->' % rel)
            continue
        rendered = render_preview(text, blocks)
        if rendered is None:
            problems.append("%s: needs exactly one re:tokens and one re:base block and at most one of each optional block" % rel)
            continue
        if EXTERNAL.search(rendered):
            problems.append("%s: previews must be self-contained; remove external URLs" % rel)
        if len(rendered.encode("utf-8")) > 256 * 1024:
            problems.append("%s: exceeds the 256 KiB sync limit" % rel)
        if rendered != text:
            if write:
                path.write_text(rendered, encoding="utf-8")
            else:
                problems.append("%s: managed blocks are stale (run generate)" % rel)
        card = {"path": rel, "name": attrs["name"], "group": attrs["group"]}
        if attrs.get("subtitle"):
            card["subtitle"] = attrs["subtitle"]
        viewport = {key: int(attrs[key]) for key in ("width", "height") if attrs.get(key, "").isdigit()}
        if viewport:
            card["viewport"] = viewport
        cards.append(card)
    return cards, problems


def manifest_text(cards):
    return json.dumps({"version": 1, "cards": cards}, indent=2, ensure_ascii=False) + "\n"


def native_literals(tokens):
    palette = {tuple(color["rgba"]) for color in tokens["colors"].values()}
    problems = []
    for path in sorted(NATIVE.glob("*.c")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for match in LITERAL.finditer(line):
                groups = match.groups()
                rgba = tuple(int(v) for v in groups[:4]) if groups[0] is not None else tuple(int(v) for v in groups[4:]) + (255,)
                if rgba not in palette:
                    problems.append("%s:%d: colour %s is not a design token" % (path.relative_to(ROOT).as_posix(), number, list(rgba)))
    return problems


def generate():
    tokens = load_tokens()
    blocks = blocks_for(tokens)
    THEME_H.write_text(theme_header(tokens), encoding="utf-8")
    TOKENS_CSS.write_text(tokens_css(tokens), encoding="utf-8")
    cards, problems = collect_cards(blocks, write=True)
    MANIFEST.write_text(manifest_text(cards), encoding="utf-8")
    for problem in problems:
        print("ERROR: " + problem)
    print("Generated theme.h, tokens.css, manifest.json and %d preview cards." % len(cards))
    return 1 if problems else 0


def check():
    tokens = load_tokens()
    blocks = blocks_for(tokens)
    problems = []

    def compare(path, expected):
        if not path.exists() or path.read_text(encoding="utf-8") != expected:
            problems.append("%s is stale or missing (run generate)" % path.relative_to(ROOT).as_posix())

    compare(THEME_H, theme_header(tokens))
    compare(TOKENS_CSS, tokens_css(tokens))
    cards, card_problems = collect_cards(blocks, write=False)
    problems += card_problems
    compare(MANIFEST, manifest_text(cards))
    problems += native_literals(tokens)
    for problem in problems:
        print("ERROR: " + problem)
    if problems:
        return 1
    print("Design tokens, native theme, %d preview cards and native colour literals are consistent." % len(cards))
    return 0


def parse_color(value):
    match = COLOR.fullmatch(value.strip())
    if not match:
        return None
    r, g, b, alpha = match.groups()
    if alpha is None:
        a = 255
    elif alpha.endswith("%"):
        a = round(float(alpha[:-1]) * 2.55)
    else:
        a = round(float(alpha) * 255) if float(alpha) <= 1 else None
    rgba = [int(r), int(g), int(b), a]
    return rgba if a is not None and all(0 <= v <= 255 for v in rgba) else None


def split_metric(tokens, name):
    for group, values in tokens["metrics"].items():
        if name.startswith(group + "-") and name[len(group) + 1:] in values:
            return group, name[len(group) + 1:]
    return None


def import_previews(paths):
    tokens = load_tokens()
    changes, warnings = [], []
    for file in paths:
        text = Path(file).read_text(encoding="utf-8")
        root = re.search(r":root\s*\{(.*?)\}", text, re.S)
        if not root:
            warnings.append("%s: no :root block found" % file)
            continue
        for kind, name, raw in DECLARATION.findall(root.group(1)):
            value = raw.strip()
            number = re.fullmatch(r"(\d+)(?:px)?", value)
            if kind == "color":
                rgba = parse_color(value)
                if name not in tokens["colors"] or rgba is None:
                    warnings.append("%s: ignored --re-color-%s: %s" % (file, name, value))
                elif tokens["colors"][name]["rgba"] != rgba:
                    changes.append("colour %s: %s -> %s" % (name, tokens["colors"][name]["rgba"], rgba))
                    tokens["colors"][name]["rgba"] = rgba
            elif kind == "metric":
                target = split_metric(tokens, name)
                if not target or not number:
                    warnings.append("%s: ignored --re-metric-%s: %s" % (file, name, value))
                elif tokens["metrics"][target[0]][target[1]] != int(number.group(1)):
                    changes.append("metric %s.%s: %d -> %s" % (target[0], target[1], tokens["metrics"][target[0]][target[1]], number.group(1)))
                    tokens["metrics"][target[0]][target[1]] = int(number.group(1))
            else:
                key = "size" if kind == "font-size" else "line-height"
                if not number or int(number.group(1)) <= 0:
                    warnings.append("%s: ignored --re-%s: %s" % (file, kind, value))
                elif tokens["typography"][key] != int(number.group(1)):
                    changes.append("typography %s: %d -> %s" % (key, tokens["typography"][key], number.group(1)))
                    tokens["typography"][key] = int(number.group(1))
    for warning in warnings:
        print("WARNING: " + warning)
    for change in changes:
        print("Changed " + change)
    if changes:
        TOKENS.write_text(dump_tokens(tokens), encoding="utf-8")
    else:
        print("No token changes found.")
    return generate()


def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command == "generate" and len(argv) == 2:
        return generate()
    if command == "check" and len(argv) == 2:
        return check()
    if command == "import" and len(argv) > 2:
        return import_previews(argv[2:])
    print(__doc__.strip())
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))

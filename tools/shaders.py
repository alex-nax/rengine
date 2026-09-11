#!/usr/bin/env python3
"""Compile the draw list's one shader into every dialect its backends need (spec 124, F133).

generate: from orchestrator/native/render/shaders/ui.glsl, emit OpenGL 3.30 source, Vulkan SPIR-V
          and Metal MSL into the committed ui_shaders.h.
check:    fail when the header no longer matches the source it was generated from.

One source, because this shader used to exist three times — inline GLSL in backend_gl.c, ui.vert and
ui.frag here, and inline MSL in backend_metal.m — and those copies had already drifted in their
attribute numbering and their Y convention even while their maths agreed.

NOT `glslc -O`. The seam's Vulkan and Metal backends look uniforms up by NAME, recovering them by
reflecting the module, and glslc's -O strips OpName with or without -g. spirv-opt -O runs the same
passes and keeps them, so the two steps are separate here.

Standard library only; glslc and spirv-cross are needed to generate, never to build the desktop.
"""
import hashlib
import re
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHADERS = ROOT / "orchestrator" / "native" / "render" / "shaders"
HEADER = SHADERS / "ui_shaders.h"
SOURCE = SHADERS / "ui.glsl"
TARGET = "vulkan1.3"

GL_PREAMBLE = """#version 330 core
#define IN(loc) layout(location = loc) in
#define OUT(loc) out
#define FLAT_OUT(loc) flat out
#define IN_F(loc) in
#define FLAT_IN(loc) flat in
#define OUT_COLOR out vec4 o_color;
"""

VK_PREAMBLE = """#version 450
#define IN(loc) layout(location = loc) in
#define OUT(loc) layout(location = loc) out
#define FLAT_OUT(loc) layout(location = loc) flat out
#define IN_F(loc) layout(location = loc) in
#define FLAT_IN(loc) layout(location = loc) flat in
#define OUT_COLOR layout(location = 0) out vec4 o_color;
"""

# The uniforms are declared once in a comment block and this script writes the dialect, because a
# function-like GLSL macro cannot take a multi-line argument: the preprocessor expands it to nothing,
# the shader compiles and links without a word, and every uniform location comes back -1.
UNIFORM_BLOCK = re.compile(r"^// UNIFORMS\n(.*?)^// END\n", re.S | re.M)


def declarations(text, vulkan):
    found = UNIFORM_BLOCK.search(text)
    if not found:
        sys.exit("%s has no `// UNIFORMS ... // END` block" % SOURCE.name)
    members, samplers = [], []
    for line in found.group(1).splitlines():
        entry = line.lstrip("/ ").strip()
        if not entry:
            continue
        kind, _, name = entry.partition(" ")
        (samplers if kind == "sampler2D" else members).append((kind, name.strip()))
    lines = []
    if vulkan:
        lines.append("layout(set = 0, binding = 0, std140) uniform Uniforms {")
        lines += ["  %s %s;" % (kind, name) for kind, name in members]
        lines.append("};")
        lines += ["layout(set = 0, binding = %d) uniform sampler2D %s;" % (1 + i, name)
                  for i, (_, name) in enumerate(samplers)]
    else:
        lines += ["uniform %s %s;" % (kind, name) for kind, name in members]
        lines += ["uniform sampler2D %s;" % name for _, name in samplers]
    return UNIFORM_BLOCK.sub("\n".join(lines) + "\n", text)


def c_bytes(text):
    """A shader as a brace-initialised char array, not a string literal.

    C99 only guarantees 4,095 characters for a string literal, and the limit applies to the
    *concatenation* — so splitting one across adjacent literals does not help. SPIRV-Cross writes a
    whole MSL body on a single line (4,898 characters for the fragment stage), which made every
    build print -Woverlength-strings. A brace list has no such limit, and the SPIR-V words below
    were already emitted this way."""
    data = text.encode("utf-8") + b"\0"
    return "\n".join(
        "  " + " ".join("0x%02x," % b for b in data[i:i + 16])
        for i in range(0, len(data), 16)
    )


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stage_sources(stage):
    """The three dialects of one stage, as (gl_source, spirv_words, msl_source)."""
    glslc = shutil.which("glslc")
    if not glslc:
        sys.exit("glslc not found; install the Vulkan SDK or `brew install shaderc`")
    body = SOURCE.read_text(encoding="utf-8")
    define = "#define VERTEX 1\n" if stage == "vertex" else ""
    gl = GL_PREAMBLE + define + declarations(body, False)
    with tempfile.TemporaryDirectory() as tmp:
        work = pathlib.Path(tmp)
        source = work / ("ui." + ("vert" if stage == "vertex" else "frag"))
        source.write_text(VK_PREAMBLE + define + declarations(body, True), encoding="utf-8")
        out = work / "ui.spv"
        done = subprocess.run([glslc, "--target-env=" + TARGET, "-o", str(out), str(source)],
                              capture_output=True, text=True)
        if done.returncode != 0:
            sys.exit("glslc failed on ui.glsl (%s):\n%s" % (stage, done.stderr))
        optimiser = shutil.which("spirv-opt")
        if optimiser:
            done = subprocess.run([optimiser, "-O", str(out), "-o", str(out)], capture_output=True, text=True)
            if done.returncode != 0:
                sys.exit("spirv-opt failed on ui.glsl (%s):\n%s" % (stage, done.stderr))
        data = out.read_bytes()
        if len(data) % 4:
            sys.exit("ui.glsl (%s): SPIR-V size is not a multiple of four" % stage)
        words = [int.from_bytes(data[i:i + 4], "little") for i in range(0, len(data), 4)]
        metal = ""
        cross = shutil.which("spirv-cross")
        if cross:
            # --flip-vert-y for the vertex stage only: Metal's clip space has +Y up like OpenGL's but
            # its framebuffer origin is top-left, so without this NDC -1 lands in the last row where
            # OpenGL puts it in the first. Vulkan needs no flip because its clip space is already
            # Y-down — two differences that cancel. See spec 124.
            flip = ["--flip-vert-y"] if stage == "vertex" else []
            # MSL 2.3: the shader discards, and SPIRV-Cross refuses to emit discard_fragment() below that
            # version because it does not formally have demote semantics there. macOS 11 and later.
            done = subprocess.run([cross, "--msl", "--msl-version", "20300"] + flip + [str(out)],
                                  capture_output=True, text=True)
            if done.returncode != 0:
                sys.exit("spirv-cross failed on ui.glsl (%s):\n%s" % (stage, done.stderr))
            metal = done.stdout
    return gl, words, metal


def generate():
    glslc = shutil.which("glslc")
    version = subprocess.run([glslc, "--version"], check=True, capture_output=True,
                             text=True).stdout.strip().splitlines()[0]
    parts = [
        "/* Generated by tools/shaders.py from shaders/ui.glsl; do not edit.",
        " * Regenerate with `python3 tools/shaders.py generate`; `check` verifies the hash below.",
        " * Compiler: %s, target %s." % (version, TARGET),
        " *",
        " * Every dialect of the draw list's one shader. It existed three times by hand until F133,",
        " * and those copies disagreed about their own attribute numbering and their Y convention. */",
        "#ifndef RENGINE_UI_SHADERS_H",
        "#define RENGINE_UI_SHADERS_H",
        "#include <stdint.h>",
        "",
        '#define RE_UI_SHADER_SOURCE_SHA256 "%s"' % digest(SOURCE),
        "",
    ]
    for stage in ("vertex", "fragment"):
        gl, words, metal = stage_sources(stage)
        parts.append("static const char re_ui_%s_glsl[] = {" % stage)
        parts.append(c_bytes(gl))
        parts.append("};")
        parts.append("static const char re_ui_%s_msl[] = {" % stage)
        parts.append(c_bytes(metal))
        parts.append("};")
        parts.append("static const uint32_t re_ui_%s_spv[] = {" % stage)
        for i in range(0, len(words), 8):
            parts.append("  " + " ".join("0x%08xu," % w for w in words[i:i + 8]))
        parts.append("};")
        parts.append("")
    parts.append("#endif")
    HEADER.write_text("\n".join(parts) + "\n", encoding="utf-8")
    print("wrote %s from %s" % (HEADER.relative_to(ROOT), SOURCE.name))


# The Vulkan adapter still compiles ui.vert/ui.frag into ui_spv.h, and will until backend_seam.c
# replaces it (F133). Leaving that pair unchecked while the new source is checked would create, for
# the length of the transition, exactly the drift this change exists to remove — so both are checked
# until the old ones are deleted with the backend that reads them.
LEGACY = [("ui.vert", "re_ui_vert_spv"), ("ui.frag", "re_ui_frag_spv")]
LEGACY_HEADER = SHADERS / "ui_spv.h"


def check_legacy():
    if not LEGACY_HEADER.exists():
        return []
    text = LEGACY_HEADER.read_text(encoding="utf-8")
    problems = []
    for name, symbol in LEGACY:
        if not (SHADERS / name).exists():
            continue
        expected = '#define %s_SOURCE_SHA256 "%s"' % (symbol.upper(), digest(SHADERS / name))
        if expected not in text:
            problems.append("%s changed since ui_spv.h was generated (the Vulkan adapter still reads it)" % name)
    return problems


def check():
    if not HEADER.exists():
        sys.exit("%s is missing; run `python3 tools/shaders.py generate`" % HEADER.relative_to(ROOT))
    text = HEADER.read_text(encoding="utf-8")
    expected = '#define RE_UI_SHADER_SOURCE_SHA256 "%s"' % digest(SOURCE)
    if expected not in text:
        sys.exit("%s changed since %s was generated.\nRun `python3 tools/shaders.py generate` and commit the result."
                 % (SOURCE.name, HEADER.name))
    for stage in ("vertex", "fragment"):
        for form in ("glsl", "msl", "spv"):
            if ("re_ui_%s_%s" % (stage, form)) not in text:
                sys.exit("%s is missing re_ui_%s_%s; regenerate it" % (HEADER.name, stage, form))
    stale = check_legacy()
    if stale:
        sys.exit("\n".join(stale) + "\nThe Vulkan adapter has not moved to the seam yet; regenerate ui_spv.h too.")
    print("draw-list shader: %s matches ui.glsl in all three dialects%s." %
          (HEADER.name, " and ui_spv.h still matches its own pair" if LEGACY_HEADER.exists() else ""))


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "check"
    if command == "generate":
        generate()
    elif command == "check":
        check()
    else:
        sys.exit("usage: tools/shaders.py generate|check")

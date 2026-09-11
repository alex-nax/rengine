#!/usr/bin/env python3
"""Compile the scene example's shaders to both dialects and commit the result (spec 124).

generate: for each .glsl here, emit the OpenGL 3.30 source and the Vulkan SPIR-V into
          scene_shaders.h, which is committed.
check:    fail when that header was generated from different sources.

glslc is needed to generate, never to build — the same rule tools/shaders.py already follows for the
desktop's own shaders, so a consumer building the pack needs no shader toolchain at all.

The macros below are the whole of the dialect difference, and they exist so the SOURCES stay
readable rather than being a thicket of #ifdef. Vulkan has no default uniform block and requires
explicit locations and set/binding numbers; OpenGL 3.30 wants plain uniforms and bare in/out.
"""
import hashlib
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
HEADER = HERE / "scene_shaders.h"
TARGET = "vulkan1.2"

GL_PREAMBLE = """#version 330 core
#define IN(loc) layout(location = loc) in
#define OUT(loc) out
#define IN_F(loc) in
#define OUT_COLOR out vec4 o_color;
"""

VK_PREAMBLE = """#version 450
#define IN(loc) layout(location = loc) in
#define OUT(loc) layout(location = loc) out
#define IN_F(loc) layout(location = loc) in
#define OUT_COLOR layout(location = 0) out vec4 o_color;
"""

# The uniforms are declared once, in a comment block, and THIS script writes the dialect. The first
# version used a function-like macro taking the whole member list as one argument — and the GLSL
# preprocessor does not accept a macro invocation spanning lines. It expanded to NOTHING, the shader
# compiled and linked without a word, every uniform location came back -1, and the scene rendered
# black. A build step that cannot fail loudly is worse than one that cannot do the job, so the
# declaration now lives somewhere no compiler will silently drop: a comment only this script reads.
UNIFORM_BLOCK = re.compile(r"^// UNIFORMS\n(.*?)^// END\n", re.S | re.M)


def uniforms(text):
    """The declared members, as (type, name), and the sampler names, in declaration order."""
    found = UNIFORM_BLOCK.search(text)
    if not found:
        sys.exit("a shader source has no `// UNIFORMS ... // END` block")
    members, samplers = [], []
    for line in found.group(1).splitlines():
        entry = line.lstrip("/ ").strip()
        if not entry:
            continue
        kind, _, name = entry.partition(" ")
        (samplers if kind == "sampler2D" else members).append((kind, name.strip()))
    return members, samplers


def declarations(text, vulkan):
    """The uniform declarations for one dialect, replacing the comment block where it stood."""
    members, samplers = uniforms(text)
    lines = []
    if vulkan:
        # No instance name, so members are spelled exactly as the OpenGL dialect spells them and the
        # call sites are identical. std140 is the layout the backend reads offsets back out of.
        lines.append("layout(set = 0, binding = 0, std140) uniform Uniforms {")
        lines += ["  %s %s;" % (kind, name) for kind, name in members]
        lines.append("};")
        lines += ["layout(set = 0, binding = %d) uniform sampler2D %s;" % (1 + i, name)
                  for i, (_, name) in enumerate(samplers)]
    else:
        lines += ["uniform %s %s;" % (kind, name) for kind, name in members]
        lines += ["uniform sampler2D %s;" % name for _, name in samplers]
    return UNIFORM_BLOCK.sub("\n".join(lines) + "\n", text)


def sources():
    return sorted(p for p in HERE.glob("*.glsl"))


def digest(paths):
    state = hashlib.sha256()
    for path in paths:
        state.update(path.name.encode())
        state.update(path.read_bytes())
    return state.hexdigest()


def c_string(text):
    out = []
    for line in text.splitlines(True):
        body = line.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
        out.append('  "%s"' % body)
    return "\n".join(out) if out else '  ""'


def spirv(glslc, path, stage, name):
    with tempfile.TemporaryDirectory() as tmp:
        work = pathlib.Path(tmp)
        source = work / ("%s.%s" % (name, "vert" if stage == "vertex" else "frag"))
        define = "#define VERTEX 1\n" if stage == "vertex" else ""
        source.write_text(VK_PREAMBLE + define + declarations(path.read_text(encoding="utf-8"), True),
                          encoding="utf-8")
        out = work / "out.spv"
        # NOT glslc -O. The seam looks uniforms up by name, and the Vulkan backend recovers those
        # names by reflecting the module — but glslc's -O strips OpName and OpMemberName, with or
        # without -g, leaving a module whose uniforms cannot be found by name at all. spirv-opt -O
        # runs the same optimisations and KEEPS them, so the two steps are separated here. A project
        # that wants stripped modules must have its generator emit an offset table instead; that is
        # the real cost of name-based lookup on Vulkan, and it is one tool flag either way.
        done = subprocess.run([glslc, "--target-env=" + TARGET, "-o", str(out), str(source)],
                              capture_output=True, text=True)
        if done.returncode != 0:
            sys.exit("glslc failed on %s (%s):\n%s" % (path.name, stage, done.stderr))
        optimiser = shutil.which("spirv-opt")
        if optimiser:
            done = subprocess.run([optimiser, "-O", str(out), "-o", str(out)],
                                  capture_output=True, text=True)
            if done.returncode != 0:
                sys.exit("spirv-opt failed on %s (%s):\n%s" % (path.name, stage, done.stderr))
        data = out.read_bytes()
    return [int.from_bytes(data[i:i + 4], "little") for i in range(0, len(data), 4)]


def generate():
    glslc = shutil.which("glslc")
    if not glslc:
        sys.exit("glslc not found; install the Vulkan SDK or `brew install shaderc`")
    version = subprocess.run([glslc, "--version"], check=True, capture_output=True,
                             text=True).stdout.strip().splitlines()[0]
    parts = [
        "/* Generated by shaders/generate.py from the .glsl sources beside it; do not edit.",
        " * Regenerate with `python3 generate.py generate`; `check` verifies the source hash below.",
        " * Compiler: %s, target %s." % (version, TARGET),
        " *",
        " * Each stage is here twice: OpenGL 3.30 source, and SPIR-V for Vulkan. ReSeamShader carries",
        " * both, so one symbol per stage serves every backend and no call site changes. */",
        "#ifndef RE_SCENE_SHADERS_H",
        "#define RE_SCENE_SHADERS_H",
        "#include <stdint.h>",
        "",
        '#define RE_SCENE_SHADER_SOURCES "%s"' % digest(sources()),
        "",
    ]
    for path in sources():
        name = path.stem
        for stage in ("vertex", "fragment"):
            define = "#define VERTEX 1\n" if stage == "vertex" else ""
            gl = GL_PREAMBLE + define + declarations(path.read_text(encoding="utf-8"), False)
            words = spirv(glslc, path, stage, name)
            symbol = "%s_%s" % (name, stage)
            parts.append("static const char re_scene_%s_glsl[] =" % symbol)
            parts.append(c_string(gl) + ";")
            parts.append("static const uint32_t re_scene_%s_spv[] = {" % symbol)
            for i in range(0, len(words), 8):
                parts.append("  " + " ".join("0x%08xu," % w for w in words[i:i + 8]))
            parts.append("};")
            parts.append("")
    parts.append("#endif")
    HEADER.write_text("\n".join(parts) + "\n", encoding="utf-8")
    print("wrote %s from %d sources" % (HEADER.name, len(sources())))


def check():
    if not HEADER.exists():
        sys.exit("%s is missing; run `generate`" % HEADER.name)
    text = HEADER.read_text(encoding="utf-8")
    found = re.search(r'#define RE_SCENE_SHADER_SOURCES "([0-9a-f]+)"', text)
    if not found:
        sys.exit("%s has no source hash; regenerate it" % HEADER.name)
    if found.group(1) != digest(sources()):
        sys.exit("%s was generated from different sources; run `generate`" % HEADER.name)
    print("scene shaders: the committed header matches its sources")


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "check"
    if command == "generate":
        generate()
    elif command == "check":
        check()
    else:
        sys.exit("usage: generate.py [generate|check]")

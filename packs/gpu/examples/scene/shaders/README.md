# One source, two dialects

Each `.glsl` file here is compiled twice by `generate.py`: once as GLSL 3.30 for the OpenGL backend
and once as Vulkan GLSL 4.50 for the Vulkan backend, which produces the SPIR-V. Both land in the
generated `scene_shaders.h`, and `ReSeamShader` carries both forms, so a call site names one symbol
and the backend takes the half it can use.

Two rules the sources follow, and the reason for each:

**No `#version` line.** It must be the first thing in a GLSL file, so it cannot sit inside an
`#ifdef` — the generator prepends the right one. This is the step the seam's OpenGL backend
deliberately does *not* do: a library cannot know a consumer's preamble convention, so the build
hands over a complete stage. vtmb-vr's F800 embed step does the same thing for the same reason.

**Uniforms live in one block.** Vulkan has no default uniform block, so `uniform mat4 u_model;` at
file scope cannot be compiled for it at all. The block is declared without an instance name, so its
members are referenced exactly as they would be in the OpenGL dialect and the call sites are
identical; on OpenGL the generator turns the block back into plain uniforms.

`generate.py check` fails when the committed header no longer matches these sources, so the binary
and its source cannot drift apart. `glslc` is needed to regenerate, never to build.

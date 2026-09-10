/* Does the C++ facade actually preserve vtmb-vr's call sites? (F123, charter D52, spec 122.)
 *
 * D52 has vtmb-vr adopting this pack "by deleting its own copy" of the seam. That claim is either
 * true at the level of source text or it is not, and the way to find out is to write the calls the
 * way VtMB writes them and see whether they compile. Every expression below is taken from a real
 * call site in ~/vtmb-vr — the argument shapes, the casts, the enum spellings and the reference
 * arguments are its own, not a convenient paraphrase. `pack-gpu-seam.test.mjs` re-derives the list
 * of methods VtMB calls and fails if one of them is missing from this file, so the fixture cannot
 * quietly drift away from the code it claims to stand for.
 *
 * This is a COMPILE-and-link test. The calls sit behind a condition that is never true, because a
 * seam with no GL context has nothing to run against — and running them is the other test's job.
 * What matters here is that the compiler accepts every one of them through the facade.
 */
#include "rengine/gpu_seam.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <vector>

// vtmb-vr writes `namespace vtmb::renderer { namespace gpu = rengine::gpu; }` when it adopts, and
// its files then keep saying `gpu::`. This is that line.
namespace vtmb::renderer
{
namespace gpu = rengine::gpu;
}
using namespace vtmb::renderer;

// The window VtMB hands to init(). The pack never knows this type — the facade's init is a template
// over "anything with glProcAddress", which is why one virtual interface in a game engine does not
// have to become a dependency of a library. Note the `const`: VtMB's is
// `virtual void* glProcAddress(const char* name) const = 0;`
struct IPlatformWindow
{
    virtual ~IPlatformWindow() = default;
    virtual void* glProcAddress(const char* name) const = 0;
};
struct TestWindow : IPlatformWindow
{
    void* glProcAddress(const char* name) const override
    {
        (void)name;
        return nullptr;
    }
};

// Shader text arrives from VtMB's F31/F800 embed step as `inline constexpr const char*`.
inline constexpr const char* k_ui_vert = "";
inline constexpr const char* k_ui_frag = "";

// A stand-in for a glm::mat4's storage: VtMB writes `&mvp[0][0]` and `glm::value_ptr(mvp)`, both of
// which reach setUniformMat4 as a `const float*`.
struct Mat4
{
    float m[4][4] = {};
    const float* operator[](int i) const { return m[i]; }
};

int main(int argc, char** argv)
{
    (void)argv;
    gpu::Device m_gpu;
    TestWindow windowStorage;
    IPlatformWindow* window = &windowStorage;

    // Members declared without an initialiser, exactly as VtMB declares them — these must read as
    // "none", which is why the facade defines its own handle structs rather than aliasing the C ones.
    gpu::Program m_program;
    gpu::Program m_texProgram;
    gpu::Buffer m_vbo;
    gpu::VertexArray m_vao;
    gpu::Texture m_fontPage;
    if (m_program.id != 0 || m_vbo.id != 0 || m_vao.id != 0 || m_fontPage.id != 0)
    {
        std::puts("a default-constructed handle must be none");
        return 1;
    }
    if (m_fontPage.width != 0 || m_fontPage.height != 0)
    {
        std::puts("a default-constructed texture must have no size");
        return 1;
    }

    if (argc > 99) // never; the point is that all of this compiles
    {
        // --- init, from draw2d.cpp:51 and renderer.cpp:30 -----------------------------------------
        if (!m_gpu.init(window))
        {
            return 1;
        }

        // --- programs and uniforms ----------------------------------------------------------------
        m_program = m_gpu.createProgram(k_ui_vert, k_ui_frag, "ui");
        m_texProgram = m_gpu.createProgram(k_ui_vert, k_ui_frag, "ui_tex");
        m_gpu.useProgram(m_program);
        const int m_orthoLoc = m_gpu.uniformLocation(m_program, "u_ortho");
        const int m_alphaLoc = m_gpu.uniformLocation(m_program, "u_alpha");
        const int m_texTintLoc = m_gpu.uniformLocation(m_texProgram, "u_tint");
        const float alpha = 1.0F;
        m_gpu.setUniform(m_alphaLoc, alpha);                              // float overload
        m_gpu.setUniform(m_gpu.uniformLocation(m_program, "u_tex"), 0);   // int overload
        struct
        {
            float r, g, b, a;
        } tint{1.0F, 1.0F, 1.0F, 1.0F};
        m_gpu.setUniform(m_texTintLoc, tint.r, tint.g, tint.b, tint.a);   // four-float overload
        Mat4 ortho;
        m_gpu.setUniformMat4(m_orthoLoc, &ortho[0][0]);
        m_gpu.destroyProgram(m_program);                                  // by non-const reference
        m_gpu.destroyProgram(m_texProgram);

        // --- buffers and layouts -------------------------------------------------------------------
        m_vbo = m_gpu.createBuffer();
        const float kTriangleVerts[9] = {};
        m_gpu.updateBuffer(m_vbo, kTriangleVerts, sizeof(kTriangleVerts), gpu::BufferUsage::Static);
        std::vector<float> m_verts(6);
        m_gpu.updateBuffer(m_vbo, m_verts.data(), m_verts.size() * sizeof(float), gpu::BufferUsage::Dynamic);
        const gpu::VertexAttribute attributes[] = {
            {0, 2, 0},
            {1, 2, 2 * sizeof(float)},
            {2, 4, 4 * sizeof(float)},
        };
        const gpu::VertexLayout layout{attributes, 3, 8 * sizeof(float)};
        m_vao = m_gpu.createVertexArray(m_vbo, layout);
        m_gpu.bindVertexArray(m_vao);
        m_gpu.bindVertexArray(gpu::VertexArray{});                        // "unbind", from skybox.cpp
        m_gpu.destroyVertexArray(m_vao);
        m_gpu.destroyBuffer(m_vbo);

        // --- textures --------------------------------------------------------------------------------
        std::array<std::uint8_t, 16> pixels{};
        constexpr int kGlyphTexels = 2;
        m_fontPage = m_gpu.createTexture2D(reinterpret_cast<const std::byte*>(pixels.data()),
                                           kGlyphTexels, kGlyphTexels, gpu::Filter::Linear,
                                           gpu::Wrap::ClampToEdge);
        m_gpu.bindTexture(m_fontPage, 0);
        gpu::Texture* t = &m_fontPage;
        m_gpu.destroyTexture(*t);                                         // through a pointer
        struct Layer
        {
            gpu::Texture tex;
        } layer;
        m_gpu.destroyTexture(layer.tex);                                  // through a member

        // --- state and draw ---------------------------------------------------------------------------
        const bool additive = false;
        const bool cullBack = true;
        const bool worldSurface = true;
        m_gpu.setBlend(gpu::Blend::None);
        m_gpu.setBlend(additive ? gpu::Blend::Additive : gpu::Blend::Alpha);
        m_gpu.setDepth(gpu::DepthTest::Disabled, gpu::DepthWrite::Disabled);
        m_gpu.setDepth(worldSurface ? gpu::DepthTest::Enabled : gpu::DepthTest::Disabled,
                       gpu::DepthWrite::Disabled);
        m_gpu.setCull(cullBack ? gpu::Cull::Back : gpu::Cull::None);
        const int m_width = 1, m_height = 1;
        m_gpu.setViewport(0, 0, m_width, m_height);
        m_gpu.clear(0.06F, 0.02F, 0.08F, 1.0F, false);
        m_gpu.draw(gpu::Primitive::Triangles, 0, 3);
        m_gpu.draw(gpu::Primitive::Lines, 0, static_cast<int>(m_verts.size() / 6));
        std::size_t vertexCount = 6;
        m_gpu.draw(gpu::Primitive::Triangles, 0, static_cast<int>(vertexCount));
        std::printf("%s\n", m_gpu.apiVersion());
    }

    std::puts("GPU seam facade: every vtmb-vr call site compiles unchanged through the pack.");
    return 0;
}

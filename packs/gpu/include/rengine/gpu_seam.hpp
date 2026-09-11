/* The seam's C++ facade: header-only, inline forwarding, no state of its own.
 *
 * WHY THIS EXISTS AT ALL. rEngine's tree is C — `AGENTS.md` says so and every other native source
 * obeys it. vtmb-vr's renderer is C++, and charter D52 has it adopting this pack *by deleting its
 * own copy* of the seam, which cannot mean rewriting thirteen files' worth of call sites. Reading
 * VtMB's `class Device` through settles how to serve both: it has about twenty-five methods and
 * **no virtuals, no templates, no inheritance and no data members** — an opaque handle with free
 * functions, written in C++ syntax. So the core is C and this is inline forwarding over it. There is
 * no tradeoff here to decide; that is why this was engineering rather than a question for the owner.
 *
 * WHAT A CONSUMER WRITES. vtmb-vr replaces `src/renderer/gpu/device.h` with:
 *
 *     #include <rengine/gpu_seam.hpp>
 *     namespace vtmb::renderer { namespace gpu = rengine::gpu; }
 *
 * and every `gpu::Device`, `gpu::Blend::Alpha`, `dev.createTexture2D(...)` keeps compiling. The one
 * call that must change is named at `init` below, with the reason.
 *
 * COST. Every method is a one-line forward to an `extern "C"` function in the same binary. Nothing
 * is virtual, so a release build inlines these away entirely; the frame path keeps the zero
 * indirection D14b/D51 chose compile-time selection to protect.
 */
#ifndef RENGINE_GPU_SEAM_HPP
#define RENGINE_GPU_SEAM_HPP

#include "rengine/gpu_seam.h"

#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace rengine::gpu
{

/* Handles carry their own zero, as VtMB's do: a `gpu::Buffer m_buffer;` member must be "none"
 * without an initialiser at every call site that declares one. A bare alias to the C struct would
 * leave it indeterminate, which is a difference no compiler would report. */
struct Buffer
{
    std::uint32_t id = 0;
};
struct Texture
{
    std::uint32_t id = 0;
    int width = 0;
    int height = 0;
};
struct Program
{
    std::uint32_t id = 0;
};
struct VertexArray
{
    std::uint32_t id = 0;
};
// A place to render, made from textures the caller owns. A default-constructed one means "whatever
// the host had bound" — the window's back buffer, or a headset runtime's image.
struct Target
{
    std::uint32_t id = 0;
    int width = 0;
    int height = 0;
};

enum class BufferUsage : std::uint8_t
{
    Static,
    Dynamic,
};
enum class Filter : std::uint8_t
{
    Nearest,
    Linear,
};
enum class Wrap : std::uint8_t
{
    ClampToEdge,
    Repeat,
};
enum class Blend : std::uint8_t
{
    None,
    Alpha,
    Additive,
};
enum class Primitive : std::uint8_t
{
    Triangles,
    Lines,
};
enum class DepthTest : std::uint8_t
{
    Disabled,
    Enabled,
};
enum class DepthWrite : std::uint8_t
{
    Disabled,
    Enabled,
};
enum class Cull : std::uint8_t
{
    None,
    Back,
};
enum class DepthCompare : std::uint8_t
{
    Less,
    LessEqual,
    Equal,
    Always,
};
enum class TextureUse : std::uint8_t
{
    Sampled,
    Color,
    Depth,
};

struct VertexAttribute
{
    int location = 0;
    int components = 0;
    std::size_t offset = 0;
};
struct VertexLayout
{
    const VertexAttribute* attributes = nullptr;
    int count = 0;
    std::size_t stride = 0;
};

// Each enumerator forwards by its VALUE, so these assertions are the mapping. Reorder either side
// and the build stops here, naming the pair — rather than a blend mode quietly becoming another one.
static_assert(static_cast<int>(BufferUsage::Static) == RE_SEAM_BUFFER_STATIC);
static_assert(static_cast<int>(BufferUsage::Dynamic) == RE_SEAM_BUFFER_DYNAMIC);
static_assert(static_cast<int>(Filter::Nearest) == RE_SEAM_FILTER_NEAREST);
static_assert(static_cast<int>(Filter::Linear) == RE_SEAM_FILTER_LINEAR);
static_assert(static_cast<int>(Wrap::ClampToEdge) == RE_SEAM_WRAP_CLAMP_TO_EDGE);
static_assert(static_cast<int>(Wrap::Repeat) == RE_SEAM_WRAP_REPEAT);
static_assert(static_cast<int>(Blend::None) == RE_SEAM_BLEND_NONE);
static_assert(static_cast<int>(Blend::Alpha) == RE_SEAM_BLEND_ALPHA);
static_assert(static_cast<int>(Blend::Additive) == RE_SEAM_BLEND_ADDITIVE);
static_assert(static_cast<int>(Primitive::Triangles) == RE_SEAM_PRIMITIVE_TRIANGLES);
static_assert(static_cast<int>(Primitive::Lines) == RE_SEAM_PRIMITIVE_LINES);
static_assert(static_cast<int>(DepthTest::Disabled) == RE_SEAM_DEPTH_TEST_DISABLED);
static_assert(static_cast<int>(DepthTest::Enabled) == RE_SEAM_DEPTH_TEST_ENABLED);
static_assert(static_cast<int>(DepthWrite::Disabled) == RE_SEAM_DEPTH_WRITE_DISABLED);
static_assert(static_cast<int>(DepthWrite::Enabled) == RE_SEAM_DEPTH_WRITE_ENABLED);
static_assert(static_cast<int>(Cull::None) == RE_SEAM_CULL_NONE);
static_assert(static_cast<int>(Cull::Back) == RE_SEAM_CULL_BACK);
static_assert(static_cast<int>(DepthCompare::Less) == RE_SEAM_DEPTH_LESS);
static_assert(static_cast<int>(DepthCompare::LessEqual) == RE_SEAM_DEPTH_LESS_EQUAL);
static_assert(static_cast<int>(DepthCompare::Equal) == RE_SEAM_DEPTH_EQUAL);
static_assert(static_cast<int>(DepthCompare::Always) == RE_SEAM_DEPTH_ALWAYS);
static_assert(static_cast<int>(TextureUse::Sampled) == RE_SEAM_TEXTURE_SAMPLED);
static_assert(static_cast<int>(TextureUse::Color) == RE_SEAM_TEXTURE_COLOR);
static_assert(static_cast<int>(TextureUse::Depth) == RE_SEAM_TEXTURE_DEPTH);

// A shader stage in whichever forms the build produced. `Shader{someGlsl}` is the common case, so
// the GLSL member is first and the constructor from a string literal is implicit on purpose.
struct Shader
{
    const char* glsl = nullptr;
    const std::uint32_t* spirv = nullptr;
    std::size_t spirvBytes = 0;
    const char* msl = nullptr;
    const char* entryPoint = nullptr;

    constexpr Shader() = default;
    constexpr Shader(const char* source) : glsl(source) {} // NOLINT(google-explicit-constructor)
    constexpr Shader(const std::uint32_t* words, std::size_t bytes) : spirv(words), spirvBytes(bytes) {}
};

namespace detail
{
inline ReSeamShader raw(const Shader& shader)
{
    ReSeamShader out{};
    out.glsl = shader.glsl;
    out.spirv = shader.spirv;
    out.spirv_bytes = shader.spirvBytes;
    out.msl = shader.msl;
    out.entry_point = shader.entryPoint;
    return out;
}
inline ReSeamVertexLayout raw(const VertexLayout& layout)
{
    // VertexAttribute is layout-compatible with its C twin by construction; assert rather than trust.
    static_assert(sizeof(VertexAttribute) == sizeof(ReSeamVertexAttribute));
    static_assert(offsetof(VertexAttribute, location) == offsetof(ReSeamVertexAttribute, location));
    static_assert(offsetof(VertexAttribute, components) == offsetof(ReSeamVertexAttribute, components));
    static_assert(offsetof(VertexAttribute, offset) == offsetof(ReSeamVertexAttribute, offset));
    ReSeamVertexLayout out{};
    out.attributes = reinterpret_cast<const ReSeamVertexAttribute*>(layout.attributes);
    out.count = layout.count;
    out.stride = layout.stride;
    return out;
}
} // namespace detail

// Stateless, like the class it generalises, and for the same reason: a graphics context is already
// per-thread state, so a Device is a way of naming it rather than a thing that owns it. Default
// construction means "whatever seam is current on this thread", which is what keeps VtMB's habit of
// declaring `gpu::Device dev;` as a local compiling untouched.
class Device
{
  public:
    Device() = default;
    explicit Device(ReSeam* seam) : m_seam(seam) {}

    // Opens the seam against the graphics context current on this thread, taking entry points from
    // the host's own loader, and makes it current. `window` may be any type with a
    // `glProcAddress(const char*)` member — which is exactly vtmb-vr's platform::IPlatformWindow, so
    // `dev.init(window)` compiles unchanged without this header knowing that type exists.
    //
    // THE ONE CALL SITE THAT MUST CHANGE: VtMB's `init(nullptr)` means "the loader already ran, use
    // the global entry points". A library that links no GL has none to use, and that is the same
    // property that lets a consumer keep its own loader and lets the pack build on a machine with no
    // GL at all. Such a call site passes its loader instead: `dev.init(&SDL_GL_GetProcAddress)` or
    // `dev.open(proc, user)`. It is one line, and it fails to compile rather than at runtime.
    template <class Window, class = std::enable_if_t<!std::is_null_pointer_v<Window>>>
    bool init(Window* window)
    {
        return open([](void* user, const char* name) -> void* {
            return reinterpret_cast<void*>(static_cast<Window*>(user)->glProcAddress(name));
        }, window);
    }
    bool init(void* (*proc)(const char*))
    {
        m_proc = proc;
        return open([](void* user, const char* name) -> void* {
            return reinterpret_cast<void* (*)(const char*)>(user)(name);
        }, reinterpret_cast<void*>(proc));
    }
    bool open(ReSeamGetProc proc, void* user, char* error = nullptr, std::size_t errorSize = 0)
    {
        ReSeamOpen options{};
        options.get_proc = proc;
        options.user = user;
        char scratch[256];
        m_seam = re_seam_open(&options, error != nullptr ? error : scratch,
                              error != nullptr ? errorSize : sizeof(scratch));
        if (m_seam != nullptr)
        {
            re_seam_make_current(m_seam);
        }
        return m_seam != nullptr;
    }
    void close()
    {
        re_seam_close(m_seam);
        m_seam = nullptr;
    }

    // --- programs ---------------------------------------------------------------------------
    Program createProgram(const Shader& vertex, const Shader& fragment, const char* debugName)
    {
        const ReSeamShader v = detail::raw(vertex);
        const ReSeamShader f = detail::raw(fragment);
        return Program{re_seam_program(seam(), &v, &f, debugName).id};
    }
    void destroyProgram(Program& program)
    {
        ReSeamProgram raw{program.id};
        re_seam_program_destroy(seam(), &raw);
        program = Program{};
    }
    void useProgram(Program program) { re_seam_program_use(seam(), ReSeamProgram{program.id}); }
    int uniformLocation(Program program, const char* name)
    {
        return re_seam_uniform_location(seam(), ReSeamProgram{program.id}, name);
    }
    void setUniform(int location, int value) { re_seam_uniform_int(seam(), location, value); }
    void setUniform(int location, float value) { re_seam_uniform_float(seam(), location, value); }
    void setUniform(int location, float x, float y) { re_seam_uniform_vec2(seam(), location, x, y); }
    void setUniform(int location, float x, float y, float z, float w)
    {
        re_seam_uniform_vec4(seam(), location, x, y, z, w);
    }
    void setUniformMat4(int location, const float* value) { re_seam_uniform_mat4(seam(), location, value); }

    // --- buffers ----------------------------------------------------------------------------
    Buffer createBuffer() { return Buffer{re_seam_buffer(seam()).id}; }
    void destroyBuffer(Buffer& buffer)
    {
        ReSeamBuffer raw{buffer.id};
        re_seam_buffer_destroy(seam(), &raw);
        buffer = Buffer{};
    }
    void updateBuffer(Buffer buffer, const void* data, std::size_t bytes, BufferUsage usage)
    {
        re_seam_buffer_update(seam(), ReSeamBuffer{buffer.id}, data, bytes,
                              static_cast<ReSeamBufferUsage>(usage));
    }

    // --- vertex layout ----------------------------------------------------------------------
    VertexArray createVertexArray(Buffer buffer, const VertexLayout& layout)
    {
        const ReSeamVertexLayout raw = detail::raw(layout);
        return VertexArray{re_seam_vertex_array(seam(), ReSeamBuffer{buffer.id}, &raw).id};
    }
    void destroyVertexArray(VertexArray& array)
    {
        ReSeamVertexArray raw{array.id};
        re_seam_vertex_array_destroy(seam(), &raw);
        array = VertexArray{};
    }
    void bindVertexArray(VertexArray array) { re_seam_vertex_array_bind(seam(), ReSeamVertexArray{array.id}); }

    // --- textures ---------------------------------------------------------------------------
    // Taken as `const void*` so both `const std::byte*` (VtMB) and `const unsigned char*` bind
    // without a cast at the call site.
    Texture createTexture2D(const void* rgba, int width, int height, Filter filter, Wrap wrap)
    {
        const ReSeamTexture raw = re_seam_texture_2d(seam(), rgba, width, height,
                                                     static_cast<ReSeamFilter>(filter),
                                                     static_cast<ReSeamWrap>(wrap));
        return Texture{raw.id, raw.width, raw.height};
    }
    void destroyTexture(Texture& texture)
    {
        ReSeamTexture raw{texture.id, texture.width, texture.height};
        re_seam_texture_destroy(seam(), &raw);
        texture = Texture{};
    }
    void bindTexture(Texture texture, int unit)
    {
        re_seam_texture_bind(seam(), ReSeamTexture{texture.id, texture.width, texture.height}, unit);
    }
    // Says what the texture is for. A depth attachment has no colour format, so this cannot be
    // inferred from the pixels being null — an attachment is made with no pixels either.
    Texture createTexture2D(const void* rgba, int width, int height, Filter filter, Wrap wrap, TextureUse use)
    {
        const ReSeamTexture raw = re_seam_texture_2d_for(seam(), rgba, width, height,
                                                         static_cast<ReSeamFilter>(filter),
                                                         static_cast<ReSeamWrap>(wrap),
                                                         static_cast<ReSeamTextureUse>(use));
        return Texture{raw.id, raw.width, raw.height};
    }
    // The backend's own object behind a texture, for a host that must do something the seam does not
    // offer — read a frame back, or hand an image to a runtime.
    std::uintptr_t textureHandle(Texture texture)
    {
        return re_seam_texture_handle(seam(), ReSeamTexture{texture.id, texture.width, texture.height});
    }
    void updateTexture(Texture texture, int x, int y, int width, int height, const void* rgba)
    {
        re_seam_texture_update(seam(), ReSeamTexture{texture.id, texture.width, texture.height},
                               x, y, width, height, rgba);
    }

    // --- render targets ---------------------------------------------------------------------
    Target createTarget(Texture color, Texture depth = Texture{})
    {
        const ReSeamTarget raw = re_seam_target(seam(), ReSeamTexture{color.id, color.width, color.height},
                                                ReSeamTexture{depth.id, depth.width, depth.height});
        return Target{raw.id, raw.width, raw.height};
    }
    void destroyTarget(Target& target)
    {
        ReSeamTarget raw{target.id, target.width, target.height};
        re_seam_target_destroy(seam(), &raw);
        target = Target{};
    }
    void bindTarget(Target target) { re_seam_target_bind(seam(), ReSeamTarget{target.id, target.width, target.height}); }
    // The target the host already owns, in the backend's own terms — the one place this API is not
    // neutral, because a window's back buffer belongs to the host and each API names it differently.
    Target adoptTarget(std::uintptr_t handle, int width, int height)
    {
        const ReSeamTarget raw = re_seam_target_adopt(seam(), handle, width, height);
        return Target{raw.id, raw.width, raw.height};
    }

    // --- the frame --------------------------------------------------------------------------
    void beginFrame(Target target = Target{})
    {
        re_seam_frame_begin(seam(), ReSeamTarget{target.id, target.width, target.height});
    }
    void endFrame() { re_seam_frame_end(seam()); }

    // --- state + draw -----------------------------------------------------------------------
    void setBlend(Blend blend) { re_seam_blend(seam(), static_cast<ReSeamBlend>(blend)); }
    void setDepth(DepthTest test, DepthWrite write)
    {
        re_seam_depth(seam(), static_cast<ReSeamDepthTest>(test), static_cast<ReSeamDepthWrite>(write));
    }
    void setCull(Cull cull) { re_seam_cull(seam(), static_cast<ReSeamCull>(cull)); }
    void setViewport(int x, int y, int width, int height) { re_seam_viewport(seam(), x, y, width, height); }
    // A negative width or height turns clipping off, which is what "no scissor" means everywhere.
    void setScissor(int x, int y, int width, int height) { re_seam_scissor(seam(), x, y, width, height); }
    void setBlendSeparate(Blend color, Blend alpha)
    {
        re_seam_blend_separate(seam(), static_cast<ReSeamBlend>(color), static_cast<ReSeamBlend>(alpha));
    }
    void setDepthCompare(DepthCompare compare)
    {
        re_seam_depth_compare(seam(), static_cast<ReSeamDepthCompare>(compare));
    }
    void clear(float r, float g, float b, float a, bool depth) { re_seam_clear(seam(), r, g, b, a, depth); }
    void draw(Primitive primitive, int first, int count)
    {
        re_seam_draw(seam(), static_cast<ReSeamPrimitive>(primitive), first, count);
    }

    const char* apiVersion() { return re_seam_api_version(seam()); }
    static const char* backend() { return re_seam_backend(); }

  private:
    ReSeam* seam() const { return m_seam != nullptr ? m_seam : re_seam_current(); }
    ReSeam* m_seam = nullptr;
    void* (*m_proc)(const char*) = nullptr;
};

} // namespace rengine::gpu

#endif

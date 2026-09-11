/* The resource-and-draw seam, exercised against a real OpenGL driver (F123, spec 122).
 *
 * The device layer's unit test could mock the whole of Vulkan because that layer only ever decides.
 * This one cannot: a seam whose job is to put pixels where the call site asked has to be judged on
 * pixels. So this opens a real GL context, renders through the seam into a framebuffer, and reads
 * the result back.
 *
 * Note who creates the framebuffer: the TEST does, with entry points it loaded itself. Render
 * targets come from outside — that is the same rule the device layer follows, and it is why an
 * OpenXR host can hand these layers swapchain images with no window in sight. The seam draws into
 * whatever is bound.
 *
 * The window is hidden and 1x1: nothing here needs to be seen, and a visible window would make the
 * suite steal focus. All rendering goes to an off-screen texture.
 */
#include "rengine/gpu_seam.h"

#include <SDL.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>

#define W 64
#define H 64

/* What the test needs from GL directly: making a render target, and reading it back. */
typedef unsigned int GLenum_t;
typedef unsigned int GLuint_t;
typedef int GLint_t;
static void (*genFramebuffers)(int, GLuint_t *);
static void (*bindFramebuffer)(GLenum_t, GLuint_t);
static void (*framebufferTexture2D)(GLenum_t, GLenum_t, GLenum_t, GLuint_t, GLint_t);
static GLenum_t (*checkFramebufferStatus)(GLenum_t);
static void (*readPixels)(GLint_t, GLint_t, int, int, GLenum_t, GLenum_t, void *);
static GLenum_t (*getError)(void);

#define GL_FRAMEBUFFER 0x8D40
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_TEXTURE_2D 0x0DE1
#define GL_RGBA 0x1908
#define GL_UNSIGNED_BYTE 0x1401

static void *load(void *user, const char *name) {
  (void)user;
  return SDL_GL_GetProcAddress(name);
}
static char messages[4096];
static void on_message(void *user, const char *message) {
  (void)user;
  strncat(messages, message, sizeof(messages) - strlen(messages) - 1);
}

/* One pixel, read back from the framebuffer. Origin is GL's: y counts up from the bottom. */
typedef struct { unsigned char r, g, b, a; } Pixel;
static Pixel pixel_at(int x, int y) {
  unsigned char rgba[4] = {0};
  readPixels(x, y, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
  Pixel p = {rgba[0], rgba[1], rgba[2], rgba[3]};
  return p;
}
static bool near(unsigned char got, unsigned char want) {
  int delta = (int)got - (int)want;
  return delta <= 2 && delta >= -2; /* a driver may round the last bit of an 8-bit blend */
}
static bool is_rgb(Pixel p, unsigned char r, unsigned char g, unsigned char b) {
  return near(p.r, r) && near(p.g, g) && near(p.b, b);
}
static void describe(const char *what, Pixel p) {
  printf("  %s: rgba(%u, %u, %u, %u)\n", what, p.r, p.g, p.b, p.a);
}

/* Two fragment shaders, one constant and one driven by a uniform, so that "the draw covered the
 * right pixels" and "the uniform reached the shader" fail SEPARATELY. With one uniform-coloured
 * shader they do not: dropping setUniform paints the triangle black, and the coverage assertion goes
 * red claiming something it was not testing. That is the failure mode the sabotage pass is for, and
 * it showed up here rather than in review. */
static const char *solid_vertex =
  "#version 330 core\n"
  "layout(location = 0) in vec2 a_pos;\n"
  "void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }\n";
static const char *constant_fragment =
  "#version 330 core\n"
  "out vec4 o_color;\n"
  "void main() { o_color = vec4(0.0, 1.0, 0.0, 1.0); }\n";
static const char *solid_fragment =
  "#version 330 core\n"
  "uniform vec4 u_color;\n"
  "out vec4 o_color;\n"
  "void main() { o_color = u_color; }\n";
/* Both stages compile; they disagree about the type of what one hands the other, which is a LINK
 * error rather than a compile error. Without a case like this, the link failure path is never
 * reached and its clean-up is a claim — the compile path returns before ever getting there. */
static const char *mismatched_vertex =
  "#version 330 core\n"
  "layout(location = 0) in vec2 a_pos;\n"
  "out vec3 v_carried;\n"
  "void main() { v_carried = vec3(a_pos, 0.0); gl_Position = vec4(a_pos, 0.0, 1.0); }\n";
static const char *mismatched_fragment =
  "#version 330 core\n"
  "in vec2 v_carried;\n"
  "out vec4 o_color;\n"
  "void main() { o_color = vec4(v_carried, 0.0, 1.0); }\n";
static const char *textured_vertex =
  "#version 330 core\n"
  "layout(location = 0) in vec2 a_pos;\n"
  "layout(location = 1) in vec2 a_uv;\n"
  "out vec2 v_uv;\n"
  "void main() { v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }\n";
static const char *textured_fragment =
  "#version 330 core\n"
  "uniform sampler2D u_texture;\n"
  "in vec2 v_uv;\n"
  "out vec4 o_color;\n"
  "void main() { o_color = texture(u_texture, v_uv); }\n";

int main(void) {
  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    printf("GPU seam: SDL video unavailable (%s); skipping\n", SDL_GetError());
    return 0;
  }
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
  SDL_Window *window = SDL_CreateWindow("seam", 0, 0, 1, 1, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
  if (window == NULL) {
    printf("GPU seam: no GL window (%s); skipping\n", SDL_GetError());
    SDL_Quit();
    return 0;
  }
  SDL_GLContext context = SDL_GL_CreateContext(window);
  if (context == NULL) {
    printf("GPU seam: no GL context (%s); skipping\n", SDL_GetError());
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
  }

  /* ---- the host's own render target ----------------------------------------------------------- */
  genFramebuffers = (void (*)(int, GLuint_t *))SDL_GL_GetProcAddress("glGenFramebuffers");
  bindFramebuffer = (void (*)(GLenum_t, GLuint_t))SDL_GL_GetProcAddress("glBindFramebuffer");
  framebufferTexture2D = (void (*)(GLenum_t, GLenum_t, GLenum_t, GLuint_t, GLint_t))SDL_GL_GetProcAddress("glFramebufferTexture2D");
  checkFramebufferStatus = (GLenum_t(*)(GLenum_t))SDL_GL_GetProcAddress("glCheckFramebufferStatus");
  readPixels = (void (*)(GLint_t, GLint_t, int, int, GLenum_t, GLenum_t, void *))SDL_GL_GetProcAddress("glReadPixels");
  getError = (GLenum_t(*)(void))SDL_GL_GetProcAddress("glGetError");
  assert(genFramebuffers && bindFramebuffer && framebufferTexture2D && readPixels && getError);

  /* ---- open the seam through the host's loader -------------------------------------------------- */
  char error[256] = {0};
  ReSeamOpen options = {0};
  options.get_proc = load;
  options.on_message = on_message;
  ReSeam *seam = re_seam_open(&options, error, sizeof(error));
  assert(seam != NULL && "the seam opens on the host's loader");
  assert(!strcmp(re_seam_backend(), "opengl"));
  assert(re_seam_api_version(seam) != NULL && strcmp(re_seam_api_version(seam), "unknown") != 0);
  printf("GL: %s\n", re_seam_api_version(seam));

  /* A seam with no loader is refused by name rather than crashed on. */
  ReSeamOpen blind = {0};
  assert(re_seam_open(&blind, error, sizeof(error)) == NULL);
  assert(strstr(error, "glGetProcAddress") != NULL);

  /* The colour target is a texture the seam made — which also proves createTexture2D accepts a null
     image, the case an attachment needs and an upload does not. */
  ReSeamTexture target = re_seam_texture_2d(seam, NULL, W, H, RE_SEAM_FILTER_NEAREST, RE_SEAM_WRAP_CLAMP_TO_EDGE);
  assert(target.id != 0 && target.width == W && target.height == H);
  GLuint_t fbo = 0;
  genFramebuffers(1, &fbo);
  bindFramebuffer(GL_FRAMEBUFFER, fbo);
  framebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, target.id, 0);
  assert(checkFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE);
  /* The test is the host, so the framebuffer it made is the frame's target. On a desktop this would
     be the window's back buffer and on a headset the runtime's image; the seam does not care which,
     which is the property being demonstrated. */
  ReSeamTarget screen = re_seam_target_adopt(seam, fbo, W, H);
  re_seam_frame_begin(seam, screen);
  re_seam_viewport(seam, 0, 0, W, H);

  /* ---- clear ------------------------------------------------------------------------------------ */
  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 1.0f, false);
  Pixel cleared = pixel_at(W / 2, H / 2);
  assert(is_rgb(cleared, 0, 0, 0) && "clear puts the colour it was given on every pixel");
  re_seam_clear(seam, 1.0f, 0.0f, 0.0f, 1.0f, false);
  Pixel red = pixel_at(W / 2, H / 2);
  describe("clear(1, 0, 0)", red);
  assert(is_rgb(red, 255, 0, 0) && "the channels arrive in the order they were passed");

  /* ---- a program, a buffer, a vertex layout and a draw ------------------------------------------ */
  ReSeamShader vs = {0}, fs = {0}, cfs = {0};
  vs.glsl = solid_vertex;
  fs.glsl = solid_fragment;
  cfs.glsl = constant_fragment;
  ReSeamProgram constant = re_seam_program(seam, &vs, &cfs, "constant");
  ReSeamProgram solid = re_seam_program(seam, &vs, &fs, "solid");
  assert(constant.id != 0 && solid.id != 0 && "a valid program links");

  /* The bottom-left half of the target: the triangle covers (0,0) and misses (W-1, H-1), so a draw
     that ignored the vertex data would have to be wrong in both corners to pass. */
  const float triangle[] = {-1.0f, -1.0f, 1.0f, -1.0f, -1.0f, 1.0f};
  ReSeamBuffer buffer = re_seam_buffer(seam);
  assert(buffer.id != 0);
  re_seam_buffer_update(seam, buffer, triangle, sizeof(triangle), RE_SEAM_BUFFER_STATIC);
  ReSeamVertexAttribute position = {0, 2, 0};
  ReSeamVertexLayout layout = {&position, 1, 2 * sizeof(float)};
  ReSeamVertexArray array = re_seam_vertex_array(seam, buffer, &layout);
  assert(array.id != 0);

  /* Coverage first, with a colour no uniform can affect. */
  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 1.0f, false);
  re_seam_program_use(seam, constant);
  re_seam_vertex_array_bind(seam, array);
  re_seam_blend(seam, RE_SEAM_BLEND_NONE);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 3);

  Pixel inside = pixel_at(2, 2);
  Pixel outside = pixel_at(W - 3, H - 3);
  describe("inside the triangle", inside);
  describe("outside the triangle", outside);
  assert(is_rgb(inside, 0, 255, 0) && "the draw covered the vertices it was given");
  assert(is_rgb(outside, 0, 0, 0) && "and only those — a full-screen draw would fail here");

  /* Then the uniform, on its own, with two different values so a stuck one cannot pass either. */
  re_seam_program_use(seam, solid);
  int u_color = re_seam_uniform_location(seam, solid, "u_color");
  assert(u_color >= 0 && "a uniform the shader declares is found by name");
  re_seam_uniform_vec4(seam, u_color, 0.0f, 0.0f, 1.0f, 1.0f);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 3);
  assert(is_rgb(pixel_at(2, 2), 0, 0, 255) && "setUniform reaches the shader, not a cached value");
  re_seam_uniform_vec4(seam, u_color, 1.0f, 0.0f, 0.0f, 1.0f);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 3);
  assert(is_rgb(pixel_at(2, 2), 255, 0, 0) && "and a second value moves it again");

  /* ---- blending --------------------------------------------------------------------------------- */
  /* Half-transparent white over the red left behind above: alpha blending gives (255, 127, 127); no
     blending gives white, and additive gives white too — so this pixel separates all three modes. */
  re_seam_blend(seam, RE_SEAM_BLEND_ALPHA);
  re_seam_uniform_vec4(seam, u_color, 1.0f, 1.0f, 1.0f, 0.5f);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 3);
  Pixel blended = pixel_at(2, 2);
  describe("alpha over red", blended);
  assert(near(blended.r, 255) && near(blended.g, 127) && near(blended.b, 127) &&
         "the blend mode asked for is the one used");

  /* ---- a texture, sampled ------------------------------------------------------------------------ */
  /* Two texels, magenta and yellow, sampled through uvs that run RIGHT TO LEFT — the texture is
     mirrored across the quad on purpose. If uv were read from the wrong place in the vertex (an
     ignored attribute offset reads the position instead, and position also runs -1..1 left to
     right), the halves would still differ and still look plausible. Reversing the mapping is what
     makes that mistake visible: it puts the wrong texel on each side rather than none. */
  const unsigned char texels[8] = {255, 0, 255, 255, 255, 255, 0, 255};
  ReSeamTexture texture = re_seam_texture_2d(seam, texels, 2, 1, RE_SEAM_FILTER_NEAREST, RE_SEAM_WRAP_CLAMP_TO_EDGE);
  assert(texture.id != 0 && texture.width == 2 && texture.height == 1);

  const float quad[] = {
    -1.0f, -1.0f, 1.0f, 0.0f,  1.0f, -1.0f, 0.0f, 0.0f,  -1.0f, 1.0f, 1.0f, 1.0f,
    -1.0f,  1.0f, 1.0f, 1.0f,  1.0f, -1.0f, 0.0f, 0.0f,   1.0f, 1.0f, 0.0f, 1.0f,
  };
  ReSeamBuffer quad_buffer = re_seam_buffer(seam);
  re_seam_buffer_update(seam, quad_buffer, quad, sizeof(quad), RE_SEAM_BUFFER_DYNAMIC);
  ReSeamVertexAttribute attributes[2] = {{0, 2, 0}, {1, 2, 2 * sizeof(float)}};
  ReSeamVertexLayout quad_layout = {attributes, 2, 4 * sizeof(float)};
  ReSeamVertexArray quad_array = re_seam_vertex_array(seam, quad_buffer, &quad_layout);

  ReSeamShader tvs = {0}, tfs = {0};
  tvs.glsl = textured_vertex;
  tfs.glsl = textured_fragment;
  ReSeamProgram textured = re_seam_program(seam, &tvs, &tfs, "textured");
  assert(textured.id != 0);

  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 1.0f, false);
  re_seam_blend(seam, RE_SEAM_BLEND_NONE);
  re_seam_program_use(seam, textured);
  re_seam_uniform_int(seam, re_seam_uniform_location(seam, textured, "u_texture"), 3);
  re_seam_texture_bind(seam, texture, 3);
  re_seam_vertex_array_bind(seam, quad_array);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 6);

  Pixel left = pixel_at(4, H / 2);
  Pixel right = pixel_at(W - 5, H / 2);
  describe("left half of the texture", left);
  describe("right half of the texture", right);
  assert(is_rgb(left, 255, 255, 0) && "the texel the uv named landed there — not the one the position would have");
  assert(is_rgb(right, 255, 0, 255) && "and the other texel on the other side");
  /* The unit is the caller's choice: binding to 3 and telling the sampler 3 is what made that work,
     so a backend that ignored the unit would have sampled an empty unit 0 and drawn black. */

  /* ---- the filter asked for is the one used ------------------------------------------------------ */
  /* At u = 0.6 the two filters disagree loudly: NEAREST takes the texel whose centre is at 0.75
     (yellow), while LINEAR mixes it with the one at 0.25 and returns about (255, 178, 76). Sampling
     at the edges cannot tell them apart, because clamping makes both filters return a pure texel
     there — which is why the first version of this test passed with the filter ignored. */
  Pixel sharp = pixel_at(25, H / 2);
  describe("nearest at u = 0.6", sharp);
  assert(is_rgb(sharp, 255, 255, 0) && "nearest returns a texel, not a mix of two");

  /* ---- the wrap asked for is the one used --------------------------------------------------------- */
  /* Everything above keeps uv inside [0, 1], where clamp and repeat are the same thing — so none of
     it could tell them apart, and a backend ignoring the wrap passed every assertion. Running uv out
     to 2 is what separates them: at u = 1.25 clamping holds the last texel, repeating comes back
     round to the first. */
  const float wide[] = {
    -1.0f, -1.0f, 0.0f, 0.0f,  1.0f, -1.0f, 2.0f, 0.0f,  -1.0f, 1.0f, 0.0f, 1.0f,
    -1.0f,  1.0f, 0.0f, 1.0f,  1.0f, -1.0f, 2.0f, 0.0f,   1.0f, 1.0f, 2.0f, 1.0f,
  };
  re_seam_buffer_update(seam, quad_buffer, wide, sizeof(wide), RE_SEAM_BUFFER_DYNAMIC);
  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 1.0f, false);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 6);
  Pixel past_the_end = pixel_at(W * 5 / 8, H / 2);
  describe("clamped at u = 1.25", past_the_end);
  assert(is_rgb(past_the_end, 255, 255, 0) && "clamping holds the last texel past the edge; repeating would return the first");

  /* ---- lines are lines ---------------------------------------------------------------------------- */
  /* Nothing above draws anything but triangles, so the primitive argument was never read. Two
     vertices drawn as triangles produce no fragments at all, which is the difference this sees. */
  const float segment[] = {-0.9f, 0.0f, 0.9f, 0.0f};
  ReSeamBuffer line_buffer = re_seam_buffer(seam);
  re_seam_buffer_update(seam, line_buffer, segment, sizeof(segment), RE_SEAM_BUFFER_STATIC);
  ReSeamVertexAttribute line_position = {0, 2, 0};
  ReSeamVertexLayout line_layout = {&line_position, 1, 2 * sizeof(float)};
  ReSeamVertexArray line_array = re_seam_vertex_array(seam, line_buffer, &line_layout);
  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 1.0f, false);
  re_seam_program_use(seam, constant);
  re_seam_vertex_array_bind(seam, line_array);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_LINES, 0, 2);
  /* A line at y = 0 in clip space falls on one of the two middle rows depending on how the driver
     rounds the pixel centre; both are "on the line", and picking one would make this flaky. */
  Pixel on_the_line = pixel_at(W / 2, H / 2);
  Pixel just_under = pixel_at(W / 2, H / 2 - 1);
  Pixel below_it = pixel_at(W / 2, H / 4);
  describe("on the line (upper row)", on_the_line);
  describe("on the line (lower row)", just_under);
  assert((is_rgb(on_the_line, 0, 255, 0) || is_rgb(just_under, 0, 255, 0)) &&
         "a line primitive drew a line; two vertices as triangles would have drawn nothing");
  assert(is_rgb(below_it, 0, 0, 0) && "and only along it");
  re_seam_vertex_array_destroy(seam, &line_array);
  re_seam_buffer_destroy(seam, &line_buffer);

  /* ---- scissor ------------------------------------------------------------------------------------ */
  /* Clip to the left half and clear: the clear must respect the clip, which is what makes scissor
     worth having at all in an immediate-mode UI — every panel clears its own ground. */
  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 1.0f, false);
  re_seam_scissor(seam, 0, 0, W / 2, H);
  re_seam_clear(seam, 0.0f, 1.0f, 1.0f, 1.0f, false);
  re_seam_scissor(seam, 0, 0, -1, -1);
  Pixel clipped_in = pixel_at(4, H / 2);
  Pixel clipped_out = pixel_at(W - 5, H / 2);
  describe("inside the scissor", clipped_in);
  describe("outside the scissor", clipped_out);
  assert(is_rgb(clipped_in, 0, 255, 255) && "the clipped clear reached inside the rectangle");
  assert(is_rgb(clipped_out, 0, 0, 0) && "and stopped at its edge");
  /* And turning it off restores the whole surface. This has to clear to a colour that is not already
     there: the first version cleared black onto a black right half, so it passed with clipping still
     on — a scissor that never released would have gone unnoticed until a later, unrelated assertion. */
  re_seam_clear(seam, 1.0f, 0.0f, 1.0f, 1.0f, false);
  assert(is_rgb(pixel_at(4, H / 2), 255, 0, 255) && is_rgb(pixel_at(W - 5, H / 2), 255, 0, 255) &&
         "a negative rectangle turns clipping off, and the next clear reaches both halves");
  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 1.0f, false);

  /* ---- a sub-rectangle of a texture --------------------------------------------------------------- */
  /* A glyph atlas writes one rectangle per glyph. Replacing only the left texel must leave the right
     one alone — an implementation that re-uploaded the whole image would pass a test that checked
     only the rectangle it wrote. */
  const unsigned char one_texel[4] = {0, 0, 255, 255};
  re_seam_texture_update(seam, texture, 0, 0, 1, 1, one_texel);
  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 1.0f, false);
  re_seam_program_use(seam, textured);
  re_seam_uniform_int(seam, re_seam_uniform_location(seam, textured, "u_texture"), 3);
  re_seam_texture_bind(seam, texture, 3);
  re_seam_vertex_array_bind(seam, quad_array);
  re_seam_buffer_update(seam, quad_buffer, quad, sizeof(quad), RE_SEAM_BUFFER_DYNAMIC);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 6);
  Pixel replaced = pixel_at(W - 5, H / 2);   /* uv runs right to left, so this samples texel 0 */
  Pixel untouched = pixel_at(4, H / 2);
  describe("the replaced texel", replaced);
  describe("the texel left alone", untouched);
  assert(is_rgb(replaced, 0, 0, 255) && "the sub-rectangle replaced the texel it named");
  assert(is_rgb(untouched, 255, 255, 0) && "and left the one it did not name");

  /* ---- a render target the seam made, sampled by a later draw -------------------------------------- */
  /* This is the addition F129 exists for. Render into an off-screen colour texture, then sample that
     texture in a draw to the main target. If the target were ignored and the pass went to the
     default framebuffer, the sample would read an untouched texture and the final pixel would be
     black — so one assertion covers both halves. */
  ReSeamTexture offscreen = re_seam_texture_2d_for(seam, NULL, 8, 8, RE_SEAM_FILTER_NEAREST,
                                                   RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_COLOR);
  ReSeamTexture offscreen_depth = re_seam_texture_2d_for(seam, NULL, 8, 8, RE_SEAM_FILTER_NEAREST,
                                                         RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_DEPTH);
  ReSeamTarget pass = re_seam_target(seam, offscreen, offscreen_depth);
  assert(pass.id != 0 && pass.width == 8 && pass.height == 8 && "a target made from the host's textures");

  re_seam_target_bind(seam, pass);
  re_seam_viewport(seam, 0, 0, 8, 8);
  re_seam_clear(seam, 1.0f, 0.5f, 0.0f, 1.0f, true);   /* an orange nobody else in this test uses */
  re_seam_target_bind(seam, (ReSeamTarget){0, 0, 0});   /* back to the frame's target */
  re_seam_viewport(seam, 0, 0, W, H);

  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 1.0f, false);
  re_seam_texture_bind(seam, offscreen, 3);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 6);
  Pixel sampled = pixel_at(W / 2, H / 2);
  describe("the off-screen pass, sampled", sampled);
  assert(is_rgb(sampled, 255, 128, 0) && "the pass rendered into the target and a later draw read it");
  /* And the frame's target was not what the pass cleared: if it had been, this corner would be
     green. This is the assertion that separates "a zero target is the frame's" from "a zero target
     is the window": with the latter, the drawing above lands on a 1x1 window and this reads nothing. */
  re_seam_target_bind(seam, pass);
  re_seam_clear(seam, 0.0f, 1.0f, 0.0f, 1.0f, false);
  re_seam_target_bind(seam, (ReSeamTarget){0, 0, 0});
  assert(is_rgb(pixel_at(2, 2), 255, 128, 0) &&
         "clearing the off-screen target left the frame's target alone");

  /* ---- depth, compared the way the caller asked ---------------------------------------------------- */
  /* Two draws at the same depth. With LESS the second is rejected; with EQUAL it wins. Nothing else
     in this test enables depth at all, so this is the only place the depth state is observable. */
  re_seam_target_bind(seam, pass);
  re_seam_viewport(seam, 0, 0, 8, 8);
  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 1.0f, true);
  re_seam_depth(seam, RE_SEAM_DEPTH_TEST_ENABLED, RE_SEAM_DEPTH_WRITE_ENABLED);
  re_seam_program_use(seam, constant);
  re_seam_vertex_array_bind(seam, array);
  re_seam_blend(seam, RE_SEAM_BLEND_NONE);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 3);        /* green, writes depth */
  re_seam_program_use(seam, solid);
  re_seam_uniform_vec4(seam, re_seam_uniform_location(seam, solid, "u_color"), 1.0f, 0.0f, 0.0f, 1.0f);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 3);        /* red, same depth: LESS rejects it */
  unsigned char probe[4] = {0};
  readPixels(1, 1, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, probe);
  describe("equal depth under LESS", (Pixel){probe[0], probe[1], probe[2], probe[3]});
  assert(near(probe[1], 255) && near(probe[0], 0) && "LESS rejects a fragment at the same depth");
  re_seam_depth_compare(seam, RE_SEAM_DEPTH_EQUAL);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 3);
  readPixels(1, 1, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, probe);
  describe("equal depth under EQUAL", (Pixel){probe[0], probe[1], probe[2], probe[3]});
  assert(near(probe[0], 255) && near(probe[1], 0) && "EQUAL accepts it — the compare function is the caller's");
  /* A depth clear is masked by the depth write mask, in OpenGL and therefore in every backend that
     claims call sites see no difference. With writes off, the clear below must do NOTHING: the
     depth the green draw wrote is still there, and LESS still rejects the red draw at the same
     depth. Preserved deliberately from vtmb-vr — "a call site that clears depth sets the write
     itself" — and until now nothing checked it, which is how the scene example walked straight into
     it and spent an afternoon looking like a broken render target. */
  re_seam_depth_compare(seam, RE_SEAM_DEPTH_LESS);   /* back to rejecting a tie */
  re_seam_depth(seam, RE_SEAM_DEPTH_TEST_ENABLED, RE_SEAM_DEPTH_WRITE_DISABLED);
  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 1.0f, true);
  re_seam_program_use(seam, solid);
  re_seam_uniform_vec4(seam, re_seam_uniform_location(seam, solid, "u_color"), 0.0f, 0.0f, 1.0f, 1.0f);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 3);
  readPixels(1, 1, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, probe);
  describe("after a clear with depth writes off", (Pixel){probe[0], probe[1], probe[2], probe[3]});
  assert(near(probe[2], 0) &&
         "the depth clear was masked away, so the old depth still rejected this draw — had the "
         "clear taken effect, this pixel would be blue");

  re_seam_depth_compare(seam, RE_SEAM_DEPTH_LESS);
  re_seam_depth(seam, RE_SEAM_DEPTH_TEST_DISABLED, RE_SEAM_DEPTH_WRITE_DISABLED);
  re_seam_target_bind(seam, (ReSeamTarget){0, 0, 0});
  re_seam_viewport(seam, 0, 0, W, H);
  re_seam_target_destroy(seam, &pass);
  assert(pass.id == 0);
  re_seam_texture_destroy(seam, &offscreen);
  re_seam_texture_destroy(seam, &offscreen_depth);

  /* ---- separate alpha blending ---------------------------------------------------------------------- */
  /* Colour blends with the source alpha while the alpha channel accumulates instead. Over a ground
     of alpha 0.5 with a source of alpha 0.5 the two modes are far apart and the arithmetic is worth
     writing down, because "roughly higher" is not a test:
         both channels Alpha:  0.5*0.5 + 0.5*(1-0.5) = 0.50 -> 127
         alpha channel added:  0.5*0.5 + 0.5*1       = 0.75 -> 191
     so the alpha this reads separates the two beyond any rounding. */
  re_seam_clear(seam, 0.0f, 0.0f, 0.0f, 0.5f, false);
  re_seam_program_use(seam, solid);
  re_seam_vertex_array_bind(seam, array);
  re_seam_uniform_vec4(seam, re_seam_uniform_location(seam, solid, "u_color"), 1.0f, 1.0f, 1.0f, 0.5f);
  re_seam_blend_separate(seam, RE_SEAM_BLEND_ALPHA, RE_SEAM_BLEND_ADDITIVE);
  re_seam_draw(seam, RE_SEAM_PRIMITIVE_TRIANGLES, 0, 3);
  Pixel separate = pixel_at(2, 2);
  describe("separate alpha", separate);
  assert(near(separate.r, 127) && "colour still blended with the source alpha");
  assert(near(separate.a, 191) &&
         "while the alpha channel accumulated — a single blend mode for both would leave 127 here");
  re_seam_blend(seam, RE_SEAM_BLEND_NONE);

  /* ---- the frame bracket ------------------------------------------------------------------------------ */
  /* OpenGL needs no bracket, so the only thing observable here is that it is tracked: a second begin
     without an end is a mistake a command-buffer backend cannot survive, and it is reported now
     rather than discovered there. */
  messages[0] = '\0';
  re_seam_frame_begin(seam, screen);
  assert(strstr(messages, "never ended") != NULL && "an unbalanced frame is named, not ignored");
  re_seam_frame_end(seam);
  messages[0] = '\0';
  re_seam_frame_end(seam);
  assert(strstr(messages, "outside a frame") != NULL && "and so is an end without a begin");
  re_seam_frame_begin(seam, screen);

  /* ---- failures are reported, not swallowed ------------------------------------------------------ */
  messages[0] = '\0';
  ReSeamShader broken = {0};
  broken.glsl = "#version 330 core\nthis is not glsl\n";
  ReSeamProgram bad = re_seam_program(seam, &broken, &fs, "deliberately-broken");
  assert(bad.id == 0 && "a shader that does not compile yields no program");
  assert(strstr(messages, "deliberately-broken") != NULL &&
         "the diagnostic names the program, which is the only way to tell two failures apart");

  messages[0] = '\0';
  ReSeamShader link_vs = {0}, link_fs = {0};
  link_vs.glsl = mismatched_vertex;
  link_fs.glsl = mismatched_fragment;
  ReSeamProgram unlinkable = re_seam_program(seam, &link_vs, &link_fs, "cannot-link");
  assert(unlinkable.id == 0 && "a program that compiles but does not link yields no program either");
  assert(strstr(messages, "cannot-link") != NULL && "and the link diagnostic names it too");

  messages[0] = '\0';
  ReSeamShader spirv_only = {0};
  static const uint32_t words[1] = {0x07230203u};
  spirv_only.spirv = words;
  spirv_only.spirv_bytes = sizeof(words);
  ReSeamProgram wrong_form = re_seam_program(seam, &spirv_only, &fs, "spirv-on-gl");
  assert(wrong_form.id == 0);
  assert(strstr(messages, "ReSeamShader.glsl") != NULL &&
         "a stage in the wrong form names the field and the build step, not the driver — a driver's "
         "own compile error also says \"GLSL\", so asking for that word proved nothing");

  /* ---- destroying clears the handle -------------------------------------------------------------- */
  re_seam_program_destroy(seam, &constant);
  re_seam_program_destroy(seam, &solid);
  assert(solid.id == 0 && "a destroyed handle reads as none, so a double free is not a live id");
  re_seam_buffer_destroy(seam, &buffer);
  assert(buffer.id == 0);
  re_seam_vertex_array_destroy(seam, &array);
  assert(array.id == 0);
  re_seam_texture_destroy(seam, &texture);
  assert(texture.id == 0 && texture.width == 0);

  /* Nothing above left GL unhappy; a silent GL error would mean some call did not do what it said. */
  assert(getError() == 0 && "the whole run left no GL error behind");

  re_seam_close(seam);
  SDL_GL_DeleteContext(context);
  SDL_DestroyWindow(window);
  SDL_Quit();
  puts("GPU seam: clear, programs, uniforms, buffers, layouts, textures, blending and draws passed.");
  return 0;
}

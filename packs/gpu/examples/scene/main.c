/* The scene example: a window, a frame loop, and a snapshot mode (F132, spec 124).
 *
 * This is the pack's consumer. It exists so three backends can be compared on pixels produced by one
 * set of call sites — which is the D14c question, and the reason charter D53 has rEngine proving the
 * seam on itself rather than waiting for a game to do it.
 *
 * SDL is used for the window, the GL context and the entry-point loader. That is the host's job in
 * this design: the seam links no graphics library and takes `glGetProcAddress` from whoever opened
 * the context. A different host would use GLFW, or a platform window, or an OpenXR session.
 */
#include "scene.h"

#include <SDL.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The host's own render-target plumbing, which the seam deliberately does not provide: making a
 * framebuffer is the host's business in exactly the way making a window is. */
static void (*genFramebuffers)(int, unsigned *);
static void (*bindFramebuffer)(unsigned, unsigned);
static void (*framebufferTexture2D)(unsigned, unsigned, unsigned, unsigned, int);
static void (*readPixels)(int, int, int, int, unsigned, unsigned, void *);
#define GL_FRAMEBUFFER 0x8D40
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_DEPTH_ATTACHMENT 0x8D00
#define GL_TEXTURE_2D 0x0DE1
#define GL_RGBA 0x1908
#define GL_UNSIGNED_BYTE 0x1401

static void *load_proc(void *user, const char *name) {
  (void)user;
  return SDL_GL_GetProcAddress(name);
}
static void on_message(void *user, const char *message) {
  (void)user;
  fprintf(stderr, "%s\n", message);
}

/* A bottom-up 32-bit BMP: the format every snapshot in this repository already uses, so
 * tools/render_compare.py and tools/bmp_to_png.py read it without being told anything. Thirty-two
 * bits also means no row padding, which is one fewer thing to get wrong. */
static bool write_bmp(const char *path, const unsigned char *rgba, int width, int height) {
  FILE *file = fopen(path, "wb");
  if (file == NULL) return false;
  unsigned image = (unsigned)width * (unsigned)height * 4u;
  unsigned char header[54] = {0};
  header[0] = 'B'; header[1] = 'M';
  unsigned total = 54u + image, offset = 54u, info = 40u;
  unsigned short planes = 1, bits = 32;
  memcpy(header + 2, &total, 4);
  memcpy(header + 10, &offset, 4);
  memcpy(header + 14, &info, 4);
  memcpy(header + 18, &width, 4);
  memcpy(header + 22, &height, 4);   /* positive: bottom-up, which is the order GL read them in */
  memcpy(header + 26, &planes, 2);
  memcpy(header + 28, &bits, 2);
  memcpy(header + 34, &image, 4);
  fwrite(header, 1, sizeof(header), file);
  for (int y = 0; y < height; y++) {
    const unsigned char *line = rgba + (size_t)y * (size_t)width * 4;
    for (int x = 0; x < width; x++) {
      const unsigned char bgra[4] = {line[x * 4 + 2], line[x * 4 + 1], line[x * 4], 255};
      fwrite(bgra, 1, 4, file);
    }
  }
  fclose(file);
  return true;
}

static void usage(void) {
  printf(
    "scene — the rengine-gpu seam, rendering something\n"
    "\n"
    "  --snapshot FILE   render --frames frames off-screen, write a BMP and exit\n"
    "  --frames N        how many frames to advance before the snapshot (default 60)\n"
    "  --size W H        render size (default 1280 720)\n"
    "  --scene FILE      render an OBJ instead of the built-in scene; see fetch-sponza.sh\n"
    "  --orbit F         camera distance, in multiples of the model's radius (default 1.15)\n"
    "  --eye F           camera height, likewise (default 0.25). A building wants about\n"
    "                    --orbit 0.2 --eye 0.02, which stands the camera inside it.\n"
    "  --help            this text\n"
    "\n"
    "Backend: %s, chosen when the pack was built (-DRENGINE_GPU_SEAM_BACKEND).\n",
    re_seam_backend());
}

int main(int argc, char **argv) {
  const char *snapshot = NULL, *model = NULL;
  int frames = 60, width = 1280, height = 720;
  float orbit = 0.0f, eye_height = 0.0f;   /* zero means "keep the scene's default" */
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--snapshot") && i + 1 < argc) snapshot = argv[++i];
    else if (!strcmp(argv[i], "--frames") && i + 1 < argc) frames = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--scene") && i + 1 < argc) model = argv[++i];
    else if (!strcmp(argv[i], "--size") && i + 2 < argc) { width = atoi(argv[++i]); height = atoi(argv[++i]); }
    else if (!strcmp(argv[i], "--orbit") && i + 1 < argc) orbit = (float)atof(argv[++i]);
    else if (!strcmp(argv[i], "--eye") && i + 1 < argc) eye_height = (float)atof(argv[++i]);
    else if (!strcmp(argv[i], "--help")) { usage(); return 0; }
    else { fprintf(stderr, "scene: unknown argument '%s'\n", argv[i]); usage(); return 2; }
  }
  if (width <= 0 || height <= 0 || frames < 0) {
    fprintf(stderr, "scene: --size must be positive and --frames non-negative\n");
    return 2;
  }

  if (SDL_Init(SDL_INIT_VIDEO) != 0) {
    fprintf(stderr, "scene: SDL video unavailable (%s)\n", SDL_GetError());
    return 1;
  }
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
  SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
  /* A snapshot renders into its own target, so its window stays hidden and never steals focus — a
     test that grabs the screen is a test nobody runs twice. */
  Uint32 flags = SDL_WINDOW_OPENGL | (snapshot != NULL ? SDL_WINDOW_HIDDEN : SDL_WINDOW_SHOWN);
  SDL_Window *window = SDL_CreateWindow("rengine-gpu scene", SDL_WINDOWPOS_CENTERED,
                                        SDL_WINDOWPOS_CENTERED, width, height, flags);
  if (window == NULL) {
    fprintf(stderr, "scene: no window (%s)\n", SDL_GetError());
    SDL_Quit();
    return 1;
  }
  SDL_GLContext context = SDL_GL_CreateContext(window);
  if (context == NULL) {
    fprintf(stderr, "scene: no GL context (%s)\n", SDL_GetError());
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 1;
  }

  char error[512] = {0};
  ReSeamOpen options = {0};
  options.get_proc = load_proc;
  options.on_message = on_message;
  ReSeam *seam = re_seam_open(&options, error, sizeof(error));
  if (seam == NULL) {
    fprintf(stderr, "scene: %s\n", error);
    return 1;
  }
  printf("scene: %s backend, %s\n", re_seam_backend(), re_seam_api_version(seam));

  Scene scene;
  if (!scene_open(&scene, seam, width, height, model, error, sizeof(error))) {
    fprintf(stderr, "scene: %s\n", error);
    re_seam_close(seam);
    return 1;
  }
  if (orbit > 0.0f) scene.orbit = orbit;
  if (eye_height != 0.0f) scene.eye_height = eye_height;
  printf("scene: %zu vertices in %zu parts%s, centred (%.1f, %.1f, %.1f) radius %.1f\n",
         scene.geometry.vertex_count, scene.geometry.part_count, model != NULL ? " (loaded)" : "",
         (double)scene.centre.x, (double)scene.centre.y, (double)scene.centre.z, (double)scene.radius);

  ReSeamTarget screen;
  unsigned capture_fbo = 0;
  ReSeamTexture capture_color = {0}, capture_depth = {0};
  if (snapshot != NULL) {
    /* Render into a texture the host owns and read it back. Rendering to the window's back buffer
       and reading that would depend on a compositor nobody controls; this does not. */
    genFramebuffers = (void (*)(int, unsigned *))SDL_GL_GetProcAddress("glGenFramebuffers");
    bindFramebuffer = (void (*)(unsigned, unsigned))SDL_GL_GetProcAddress("glBindFramebuffer");
    framebufferTexture2D = (void (*)(unsigned, unsigned, unsigned, unsigned, int))SDL_GL_GetProcAddress("glFramebufferTexture2D");
    readPixels = (void (*)(int, int, int, int, unsigned, unsigned, void *))SDL_GL_GetProcAddress("glReadPixels");
    capture_color = re_seam_texture_2d_for(seam, NULL, width, height, RE_SEAM_FILTER_NEAREST,
                                           RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_COLOR);
    capture_depth = re_seam_texture_2d_for(seam, NULL, width, height, RE_SEAM_FILTER_NEAREST,
                                           RE_SEAM_WRAP_CLAMP_TO_EDGE, RE_SEAM_TEXTURE_DEPTH);
    genFramebuffers(1, &capture_fbo);
    bindFramebuffer(GL_FRAMEBUFFER, capture_fbo);
    framebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, capture_color.id, 0);
    framebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, capture_depth.id, 0);
    screen = re_seam_target_adopt(seam, capture_fbo, width, height);
  } else {
    screen = re_seam_target_adopt(seam, 0, width, height);   /* the window's back buffer */
  }

  int status = 0;
  if (snapshot != NULL) {
    for (int frame = 0; frame <= frames; frame++) scene_draw(&scene, seam, screen, frame);
    unsigned char *pixels = malloc((size_t)width * (size_t)height * 4);
    if (pixels == NULL) {
      fprintf(stderr, "scene: out of memory for the snapshot\n");
      status = 1;
    } else {
      bindFramebuffer(GL_FRAMEBUFFER, capture_fbo);
      readPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
      if (!write_bmp(snapshot, pixels, width, height)) {
        fprintf(stderr, "scene: cannot write %s\n", snapshot);
        status = 1;
      } else {
        printf("scene: wrote %s after %d frames\n", snapshot, frames);
      }
      free(pixels);
    }
  } else {
    bool running = true;
    for (int frame = 0; running; frame++) {
      SDL_Event event;
      while (SDL_PollEvent(&event))
        if (event.type == SDL_QUIT ||
            (event.type == SDL_KEYDOWN && event.key.keysym.sym == SDLK_ESCAPE))
          running = false;
      scene_draw(&scene, seam, screen, frame);
      SDL_GL_SwapWindow(window);
    }
  }

  re_seam_texture_destroy(seam, &capture_color);
  re_seam_texture_destroy(seam, &capture_depth);
  scene_close(&scene, seam);
  re_seam_close(seam);
  SDL_GL_DeleteContext(context);
  SDL_DestroyWindow(window);
  SDL_Quit();
  return status;
}

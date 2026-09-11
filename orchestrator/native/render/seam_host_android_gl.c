/* The OpenGL ES host for the seam-backed draw list on Android (charter D59, spec 128).
 *
 * The fifth host, and the one measurement asked for. D58 scoped mobile to Vulkan; an Adreno 619 on a
 * 2022 driver reports Vulkan 1.1 and offers neither dynamic rendering nor synchronization2, so the
 * seam's Vulkan backend cannot run there at all — while its OpenGL backend can, because every entry
 * point that backend loads exists in OpenGL ES 3.x.
 *
 * It is `seam_host_gl.c` with EGL in place of SDL: an EGL display, a config matching the window's
 * format, a context, and `eglGetProcAddress` as the loader the seam takes its entry points from.
 * `backend_seam.c` above it is the desktop's renderer, unchanged and unaware.
 */
#include "render/seam_host.h"

#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include <android/log.h>
#include <android/native_window.h>

#include <stdio.h>
#include <stdlib.h>

#define TAG "rengine.companion"

struct ReSeamHost {
  ANativeWindow *window;
  EGLDisplay display;
  EGLSurface surface;
  EGLContext context;
  EGLConfig config;
  ReSeam *seam;
  int width, height;
};

/* eglGetProcAddress answers for core ES entry points on Android as well as extensions, which is what
   lets the pack keep linking no graphics library of its own. */
static void *load_proc(void *user, const char *name) {
  (void)user;
  return (void *)eglGetProcAddress(name);
}
static void on_message(void *user, const char *message) {
  (void)user;
  __android_log_print(ANDROID_LOG_WARN, TAG, "gpu: %s", message);
}

void re_seam_host_fail(const char *message) {
  __android_log_print(ANDROID_LOG_ERROR, TAG, "%s", message);
}

uint32_t re_seam_host_flags(void) { return 0; }
const char *re_seam_host_name(void) { return "opengl"; }

ReSeamHost *re_seam_host_open(void *opaque, char *error, size_t error_size) {
  ReSeamHost *host = calloc(1, sizeof(*host));
  if (!host) { snprintf(error, error_size, "out of memory"); return NULL; }
  host->window = (ANativeWindow *)opaque;

  host->display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  if (host->display == EGL_NO_DISPLAY) { snprintf(error, error_size, "no EGL display"); free(host); return NULL; }
  EGLint major = 0, minor = 0;
  if (!eglInitialize(host->display, &major, &minor)) {
    snprintf(error, error_size, "eglInitialize failed (0x%x)", eglGetError()); free(host); return NULL;
  }

  /* ES 3 with a depth buffer, because the draw list's backend asks for depth state even when this
     UI never uses it, and a config without one makes those calls meaningless rather than loud. */
  const EGLint attributes[] = {
    EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
    EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
    EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
    EGL_DEPTH_SIZE, 16,
    EGL_NONE,
  };
  EGLint configs = 0;
  if (!eglChooseConfig(host->display, attributes, &host->config, 1, &configs) || configs < 1) {
    snprintf(error, error_size, "no EGL config with ES3 and 8888 colour"); re_seam_host_close(host); return NULL;
  }
  /* ANativeWindow must be told the format the chosen config wants, or the compositor and the
     context disagree about the buffer and nothing appears. */
  EGLint format = 0;
  eglGetConfigAttrib(host->display, host->config, EGL_NATIVE_VISUAL_ID, &format);
  ANativeWindow_setBuffersGeometry(host->window, 0, 0, format);

  host->surface = eglCreateWindowSurface(host->display, host->config, host->window, NULL);
  if (host->surface == EGL_NO_SURFACE) {
    snprintf(error, error_size, "eglCreateWindowSurface failed (0x%x)", eglGetError()); re_seam_host_close(host); return NULL;
  }
  const EGLint context_attributes[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
  host->context = eglCreateContext(host->display, host->config, EGL_NO_CONTEXT, context_attributes);
  if (host->context == EGL_NO_CONTEXT) {
    snprintf(error, error_size, "eglCreateContext failed (0x%x)", eglGetError()); re_seam_host_close(host); return NULL;
  }
  if (!eglMakeCurrent(host->display, host->surface, host->surface, host->context)) {
    snprintf(error, error_size, "eglMakeCurrent failed (0x%x)", eglGetError()); re_seam_host_close(host); return NULL;
  }
  eglQuerySurface(host->display, host->surface, EGL_WIDTH, &host->width);
  eglQuerySurface(host->display, host->surface, EGL_HEIGHT, &host->height);
  __android_log_print(ANDROID_LOG_INFO, TAG, "companion: EGL %d.%d, surface %dx%d, %s",
                      major, minor, host->width, host->height, glGetString(GL_VERSION));

  ReSeamOpen options = {0};
  options.get_proc = load_proc;
  options.on_message = on_message;
  host->seam = re_seam_open(&options, error, error_size);
  if (!host->seam) { re_seam_host_close(host); return NULL; }
  return host;
}

void re_seam_host_close(ReSeamHost *host) {
  if (!host) return;
  re_seam_close(host->seam);
  if (host->display != EGL_NO_DISPLAY) {
    eglMakeCurrent(host->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (host->context != EGL_NO_CONTEXT) eglDestroyContext(host->display, host->context);
    if (host->surface != EGL_NO_SURFACE) eglDestroySurface(host->display, host->surface);
    eglTerminate(host->display);
  }
  free(host);
}

ReSeam *re_seam_host_seam(ReSeamHost *host) { return host->seam; }

void re_seam_host_size(ReSeamHost *host, int *width, int *height) {
  eglQuerySurface(host->display, host->surface, EGL_WIDTH, &host->width);
  eglQuerySurface(host->display, host->surface, EGL_HEIGHT, &host->height);
  *width = host->width;
  *height = host->height;
}

ReSeamTarget re_seam_host_acquire(ReSeamHost *host) {
  re_seam_host_size(host, &host->width, &host->height);
  /* Framebuffer zero IS the window here, exactly as on the desktop's GL host: the surface is
     adopted rather than created. */
  return re_seam_target_adopt(host->seam, 0, host->width, host->height, 0);
}

void re_seam_host_present(ReSeamHost *host) {
  eglSwapBuffers(host->display, host->surface);
}

/* The smoke snapshot this platform needs is `adb exec-out screencap`, which judges what the
   compositor showed rather than what the app believes it drew. A glReadPixels read-back would answer
   a different, weaker question. */
bool re_seam_host_snapshot(ReSeamHost *host, const char *path) {
  (void)host; (void)path;
  return false;
}

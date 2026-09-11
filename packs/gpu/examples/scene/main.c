/* The scene example: a window, a frame loop, and a snapshot mode (F132, spec 124).
 *
 * This is the pack's consumer. It exists so three backends can be compared on pixels produced by one
 * set of call sites — which is the D14c question, and the reason charter D53 has rEngine proving the
 * seam on itself rather than waiting for a game to do it.
 *
 * Everything platform-shaped lives behind `host.h` — the window, the device, the read-back — with
 * one implementation per backend. That split is what makes "no call-site difference between
 * backends" a precise claim rather than a vague one: `scene.c` is byte-identical across all of them,
 * and the host is where they genuinely differ, because opening a GL context and opening a Vulkan
 * device are not the same act and the seam never claimed to hide it.
 */
#include "host.h"
#include "scene.h"

#include <stdbool.h>
#include <time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* A bottom-up 32-bit BMP: the format every snapshot in this repository already uses, so
 * tools/render_compare.py and tools/bmp_to_png.py read it without being told anything. */
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
  memcpy(header + 22, &height, 4);
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

  char error[512] = {0};
  Host *host = host_open(width, height, snapshot != NULL, error, sizeof(error));
  if (host == NULL) {
    fprintf(stderr, "scene: %s\n", error);
    return 1;
  }
  ReSeam *seam = host_seam(host);
  printf("scene: %s backend, %s\n", re_seam_backend(), re_seam_api_version(seam));
  Scene scene;
  if (!scene_open(&scene, seam, width, height, model, error, sizeof(error))) {
    fprintf(stderr, "scene: %s\n", error);
    host_close(host);
    return 1;
  }
  if (orbit > 0.0f) scene.orbit = orbit;
  if (eye_height != 0.0f) scene.eye_height = eye_height;
  printf("scene: %zu vertices in %zu parts%s, centred (%.1f, %.1f, %.1f) radius %.1f\n",
         scene.geometry.vertex_count, scene.geometry.part_count, model != NULL ? " (loaded)" : "",
         (double)scene.centre.x, (double)scene.centre.y, (double)scene.centre.z, (double)scene.radius);

  ReSeamTarget screen = host_target(host);
  int status = 0;
  if (snapshot != NULL) {
    /* The median rather than the mean: the first frame pays for every pipeline the scene needs and
       every buffer it uploads, and an average over sixty frames hides that in a way that flatters
       whichever backend front-loads more. Reporting both is what makes the number comparable. */
    double *taken = malloc((size_t)(frames + 1) * sizeof(double));
    struct timespec run_start;
    clock_gettime(CLOCK_MONOTONIC, &run_start);
    for (int frame = 0; frame <= frames; frame++) {
      struct timespec start, stop;
      clock_gettime(CLOCK_MONOTONIC, &start);
      scene_draw(&scene, seam, screen, frame);
      clock_gettime(CLOCK_MONOTONIC, &stop);
      if (taken != NULL)
        taken[frame] = (double)(stop.tv_sec - start.tv_sec) * 1000.0 +
                       (double)(stop.tv_nsec - start.tv_nsec) / 1000000.0;
    }
    if (taken != NULL && frames > 0) {
      for (int i = 1; i <= frames; i++)          /* insertion sort: sixty items, once */
        for (int k = i; k > 0 && taken[k] < taken[k - 1]; k--) {
          double swap = taken[k]; taken[k] = taken[k - 1]; taken[k - 1] = swap;
        }
      struct timespec run_stop;
      clock_gettime(CLOCK_MONOTONIC, &run_stop);
      double total = (double)(run_stop.tv_sec - run_start.tv_sec) * 1000.0 +
                     (double)(run_stop.tv_nsec - run_start.tv_nsec) / 1000000.0;
      /* Two numbers, because one would mislead. The per-frame median is what the CALL SITE waited
         for, and the backends do not promise the same thing there: the OpenGL backend's frame ends
         with a flush and returns while the GPU is still working, and the Vulkan backend's submits
         and waits. Comparing those medians would report a difference in synchronisation as a
         difference in speed. The total covers the whole run and ends with a read-back that forces
         both to finish, so it is the one that compares like with like. */
      printf("scene: frame median %.3f ms (call-site wait), first %.3f ms, slowest %.3f ms; "
             "%.1f ms total for %d frames = %.3f ms/frame\n",
             taken[(frames + 1) / 2], taken[0], taken[frames], total, frames + 1,
             total / (double)(frames + 1));
    }
    free(taken);
    unsigned char *pixels = malloc((size_t)width * (size_t)height * 4);
    if (pixels == NULL) {
      fprintf(stderr, "scene: out of memory for the snapshot\n");
      status = 1;
    } else if (!host_read(host, pixels, error, sizeof(error))) {
      fprintf(stderr, "scene: %s\n", error);
      status = 1;
    } else if (!write_bmp(snapshot, pixels, width, height)) {
      fprintf(stderr, "scene: cannot write %s\n", snapshot);
      status = 1;
    } else {
      printf("scene: wrote %s after %d frames\n", snapshot, frames);
    }
    free(pixels);
  } else {
    for (int frame = 0; host_poll(host); frame++) {
      scene_draw(&scene, seam, screen, frame);
      host_present(host);
    }
  }

  scene_close(&scene, seam);
  host_close(host);
  return status;
}

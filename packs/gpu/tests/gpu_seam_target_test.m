/* Adopting the host's image, over and over, the way a swapchain does (spec 124, F133).
 *
 * `re_seam_target_adopt` is the seam's one API-specific escape hatch, and the three backends had
 * drifted in what it allocates: OpenGL's builds nothing (framebuffer zero IS a name), Vulkan's takes
 * a target slot, and Metal's takes a target slot AND a texture slot it retains. Only the last of
 * those needs anything given back, and `re_seam_target_destroy` was not giving it back.
 *
 * That could not be caught by the render suite -- a captured frame exhausts about half of the 256
 * texture slots, so the leak is real and invisible -- and it could not be caught by the pack's own
 * seam test, which builds against whichever single backend the pack was configured with. It is
 * checkable here because rEngine links a PREFIXED copy per graphics API, so a test can name the
 * Metal one specifically while writing the seam's ordinary API.
 *
 * No window: a Metal device exists without one, which is the whole reason this is a unit test and
 * not another captured frame.
 */
#import <Metal/Metal.h>
#include <rengine/gpu_seam.h>

#include <assert.h>
#include <stdio.h>
#include <string.h>

/* Comfortably past the backend's 256 texture slots and 32 target slots: a leak of either shows up
 * well before this, and a correct implementation does not care how high it goes. */
#define ROUNDS 2048

int main(void) {
  @autoreleasepool {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (device == nil) { printf("no Metal device on this machine; nothing to test\n"); return 0; }

    char error[256] = {0};
    ReSeamOpen options = {0};
    options.user = (__bridge void *)device;
    ReSeam *seam = re_seam_open(&options, error, sizeof(error));
    assert(seam != NULL && "the Metal seam opened on the host's device");

    MTLTextureDescriptor *description =
      [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
                                                         width:64 height:64 mipmapped:NO];
    description.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
    id<MTLTexture> image = [device newTextureWithDescriptor:description];
    assert(image != nil && "the host made an image of its own to stand in for a drawable");

    /* The loop is the test. A host acquires an image, wraps it, draws, presents and lets it go --
       and does that sixty times a second for as long as the window is open. */
    for (int round = 0; round < ROUNDS; round++) {
      ReSeamTarget target = re_seam_target_adopt(seam, (uintptr_t)(__bridge void *)image, 64, 64);
      if (target.id == 0) {
        printf("adopt refused on round %d of %d: the seam ran out of slots, so destroy is not "
               "giving back what adopt took\n", round, ROUNDS);
        assert(0 && "adopting the host's image repeatedly never runs out of slots");
      }
      assert(target.width == 64 && target.height == 64);
      re_seam_target_destroy(seam, &target);
      assert(target.id == 0 && "destroy clears the caller's handle");
    }

    /* And what destroy gives back must be the seam's own wrapper, never the caller's image: the
       host still owns what it lent, and is about to use it again. ARC will not let a test count
       references, so the check is the one that matters anyway -- the image is still an image. */
    assert(image.width == 64 && image.height == 64 && "the caller's image outlived every target");
    ReSeamTarget last = re_seam_target_adopt(seam, (uintptr_t)(__bridge void *)image, 64, 64);
    assert(last.id != 0 && "the image survived every adopt and destroy");
    re_seam_target_destroy(seam, &last);

    re_seam_close(seam);
    printf("adopted and released the host's image %d times without running out\n", ROUNDS);
  }
  return 0;
}

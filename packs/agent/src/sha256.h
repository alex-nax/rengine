/* A self-contained SHA-256, because this pack has no dependencies and the engine's own copy lives
   under the tool binaries this build deliberately does not compile. FIPS 180-4. */
#ifndef RENGINE_SHA256_H
#define RENGINE_SHA256_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t state[8];
    uint64_t length;
    uint8_t  buffer[64];
    size_t   buffered;
} re_sha256;

void re_sha256_init(re_sha256 *ctx);
void re_sha256_update(re_sha256 *ctx, const void *data, size_t len);
void re_sha256_final(re_sha256 *ctx, uint8_t out[32]);
void re_sha256_hex(const uint8_t digest[32], char out[65]);

#ifdef __cplusplus
}
#endif

#endif

/* rengine::agent — a local model behind a C ABI (charter D67/D68/D72, specs 139 and 150).
 *
 * The engine underneath is C++ (a fork of llama.cpp). This header is the only thing a consumer
 * sees, and it is C: the FFI direction in this family is Rust-imports-C, never the reverse, so a
 * Rust service, a C desktop and a game all reach the same implementation through the same door.
 *
 * Three rules this ABI enforces rather than documents:
 *
 *   1. A model is DECLARED, never discovered. `re_model_open` takes a path AND a sha256, verifies
 *      the file before the engine sees it, and refuses on mismatch. Nothing here downloads.
 *   2. A turn is CANCELLABLE within one token, from another thread, without tearing anything down.
 *   3. Nothing here opens a socket. Offloading to another machine is the caller's business; this
 *      library runs a turn and streams it back.
 */
#ifndef RENGINE_MODEL_H
#define RENGINE_MODEL_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Bumped when a shape in this header changes. A consumer that links a different major refuses
   rather than reading a struct that has moved underneath it. */
#define RE_MODEL_ABI_VERSION 1

typedef struct re_model re_model;

typedef enum {
    RE_MODEL_OK = 0,
    RE_MODEL_E_ARGS,        /* a required field was missing or malformed */
    RE_MODEL_E_DIGEST,      /* the file is not the file that was declared */
    RE_MODEL_E_LOAD,        /* the engine could not open it */
    RE_MODEL_E_RUNTIME,     /* the turn failed */
    RE_MODEL_E_CANCELLED,   /* the turn was cancelled and stopped */
    RE_MODEL_E_UNSUPPORTED  /* a declared capability this build does not implement */
} re_model_status;

/* How a model is declared. `sha256` is REQUIRED: a path alone says which file to open and nothing
   about whether it is the file somebody verified. Two correctly-named files of one model can differ
   by fifteen points of accuracy (spec 150), so an unverified open is not a convenience this ABI
   offers. */
typedef struct {
    const char *path;        /* GGUF on disk. Never fetched, never cached, never written. */
    const char *sha256;      /* 64 lowercase hex characters. NULL or malformed is refused. */
    int32_t     context;     /* tokens; 0 means the model's own training context */
    int32_t     gpu_layers;  /* layers offloaded to the GPU; -1 means all, 0 means none */
    uint32_t    seed;
    int         vocab_only;  /* load the tokenizer and no weights */
} re_model_open;

/* Called once per generated piece. Return 0 to continue, non-zero to stop — the same stop the
   cancel flag produces, so a caller has both an in-band and an out-of-band way to end a turn. */
typedef int (*re_model_on_token)(void *user, const char *text, size_t len);

typedef struct {
    const char       *prompt;
    const char       *grammar;      /* GBNF, or NULL for none */
    int32_t           max_tokens;
    float             temperature;  /* 0 is greedy, and greedy is reproducible */
    re_model_on_token on_token;     /* may be NULL to run a turn and keep only the counters */
    void             *user;
} re_model_turn;

typedef struct {
    char     description[128];   /* the engine's own description of the architecture */
    char     digest[65];         /* the verified digest, echoed back */
    uint64_t params;
    uint64_t size_bytes;
    int32_t  n_vocab;
    int32_t  n_ctx_train;
    double   load_ms;
    int64_t  resident_delta_bytes; /* 0 when this platform will not say */
} re_model_identity;

typedef struct {
    int32_t prompt_tokens;
    int32_t generated_tokens;
    double  prompt_ms;
    double  generate_ms;
    int     cancelled;
} re_model_counters;

/* Open a declared model. On failure `*out` is untouched and `err` carries a sentence naming what
   was wrong — by name, so a caller can report it without guessing. */
re_model_status re_model_open_declared(const re_model_open *declared, re_model **out,
                                       char *err, size_t err_len);

void re_model_close(re_model *model);

/* Adapters are declared beside their base and refused on mismatch. Not implemented in this build:
   no adapter may exist before the training project's readiness gate is green, so this refuses by
   name rather than pretending. */
re_model_status re_model_attach_adapter(re_model *model, const char *path, const char *sha256,
                                        char *err, size_t err_len);

/* Run one turn. Blocking; streams through `on_token`. */
re_model_status re_model_run(re_model *model, const re_model_turn *turn,
                            re_model_counters *counters, char *err, size_t err_len);

/* Ask a running turn to stop. Safe from another thread, and safe when no turn is running. The turn
   returns RE_MODEL_E_CANCELLED after at most one more token. */
void re_model_cancel(re_model *model);

re_model_status re_model_identity_of(const re_model *model, re_model_identity *out);

/* The engine build this library was compiled against. */
const char *re_model_engine_version(void);

/* The digest of a file, for a declaration a person is about to write. Separate from opening,
   because verifying and loading are different questions. */
re_model_status re_model_file_digest(const char *path, char out_hex[65], char *err, size_t err_len);

#ifdef __cplusplus
}
#endif

#endif /* RENGINE_MODEL_H */

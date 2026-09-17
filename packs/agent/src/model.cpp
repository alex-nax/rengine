/* rengine::agent — the C ABI over the engine (charter D67/D68/D72, specs 139 and 150).
 *
 * C++ because the engine is C++; every exported symbol is `extern "C"` because the door is C. No
 * exception escapes this file: a caller across an FFI boundary gets a status and a sentence.
 */
#include "rengine/model.h"

#include "sha256.h"

#include "llama.h"

#include <atomic>
#include <cstdarg>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#if defined(__APPLE__)
#include <mach/mach.h>
#elif defined(__linux__)
#include <cstdlib>
#include <unistd.h>
#endif

namespace {

void say(char *err, size_t err_len, const char *fmt, ...) {
    if (!err || err_len == 0) return;
    va_list args;
    va_start(args, fmt);
    vsnprintf(err, err_len, fmt, args);
    va_end(args);
}

/* The engine talks to stderr by default. A library that prints into somebody else's process is a
   library that cannot be embedded, so it is silenced here and the host decides what to say. */
void quiet(ggml_log_level, const char *, void *) {}

void engine_once() {
    static std::once_flag once;
    std::call_once(once, [] {
        llama_log_set(quiet, nullptr);
        llama_backend_init();
    });
}

double now_ms() {
    using clock = std::chrono::steady_clock;
    return std::chrono::duration<double, std::milli>(clock::now().time_since_epoch()).count();
}

int64_t resident_bytes() {
#if defined(__APPLE__)
    mach_task_basic_info info{};
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t) &info, &count) == KERN_SUCCESS) {
        return (int64_t) info.resident_size;
    }
    return 0;
#elif defined(__linux__)
    FILE *f = fopen("/proc/self/statm", "r");
    if (!f) return 0;
    long pages = 0, resident = 0;
    if (fscanf(f, "%ld %ld", &pages, &resident) != 2) resident = 0;
    fclose(f);
    return (int64_t) resident * (int64_t) sysconf(_SC_PAGESIZE);
#else
    return 0; /* stated rather than guessed: this platform is not asked */
#endif
}

bool hex64(const char *s) {
    if (!s) return false;
    size_t n = 0;
    for (; s[n]; n++) {
        char c = s[n];
        bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        if (!ok) return false;
    }
    return n == 64;
}

} // namespace

struct re_model {
    llama_model   *model = nullptr;
    llama_context *ctx   = nullptr;
    std::atomic<bool> cancel{false};
    std::mutex     turn_lock;
    re_model_identity identity{};
};

extern "C" {

const char *re_model_engine_version(void) {
    return llama_version();
}

re_model_status re_model_file_digest(const char *path, char out_hex[65], char *err, size_t err_len) {
    if (!path || !out_hex) {
        say(err, err_len, "re_model_file_digest: a path and a buffer are required");
        return RE_MODEL_E_ARGS;
    }
    FILE *f = fopen(path, "rb");
    if (!f) {
        say(err, err_len, "cannot read %s", path);
        return RE_MODEL_E_ARGS;
    }
    re_sha256 c;
    re_sha256_init(&c);
    std::vector<unsigned char> buf(1 << 20);
    for (;;) {
        size_t got = fread(buf.data(), 1, buf.size(), f);
        if (got) re_sha256_update(&c, buf.data(), got);
        if (got < buf.size()) break;
    }
    bool bad = ferror(f) != 0;
    fclose(f);
    if (bad) {
        say(err, err_len, "read failed part way through %s", path);
        return RE_MODEL_E_ARGS;
    }
    unsigned char digest[32];
    re_sha256_final(&c, digest);
    re_sha256_hex(digest, out_hex);
    return RE_MODEL_OK;
}

re_model_status re_model_open_declared(const re_model_open *declared, re_model **out,
                                       char *err, size_t err_len) {
    if (!declared || !out) {
        say(err, err_len, "re_model_open_declared: a declaration and an out pointer are required");
        return RE_MODEL_E_ARGS;
    }
    if (!declared->path || !declared->path[0]) {
        say(err, err_len, "the declaration names no path");
        return RE_MODEL_E_ARGS;
    }
    /* A declaration without a digest is refused rather than defaulted. A path says which file to
       open; only a digest says it is the file somebody verified. */
    if (!hex64(declared->sha256)) {
        say(err, err_len, "%s is declared without a sha256 (64 lowercase hex characters); "
                          "an unverified model is refused", declared->path);
        return RE_MODEL_E_ARGS;
    }

    char actual[65];
    re_model_status st = re_model_file_digest(declared->path, actual, err, err_len);
    if (st != RE_MODEL_OK) return st;
    if (std::strcmp(actual, declared->sha256) != 0) {
        say(err, err_len, "%s does not match its declaration: declared %s, found %s",
            declared->path, declared->sha256, actual);
        return RE_MODEL_E_DIGEST;
    }

    engine_once();

    const double t0 = now_ms();
    const int64_t rss0 = resident_bytes();

    llama_model_params mp = llama_model_default_params();
    mp.vocab_only  = declared->vocab_only != 0;
    mp.n_gpu_layers = declared->gpu_layers < 0 ? 999 : declared->gpu_layers;

    llama_model *model = llama_model_load_from_file(declared->path, mp);
    if (!model) {
        say(err, err_len, "the engine could not load %s", declared->path);
        return RE_MODEL_E_LOAD;
    }

    llama_context *ctx = nullptr;
    if (!mp.vocab_only) {
        llama_context_params cp = llama_context_default_params();
        if (declared->context > 0) cp.n_ctx = (uint32_t) declared->context;
        cp.n_batch = cp.n_ctx > 0 && cp.n_ctx < 512 ? cp.n_ctx : 512;
        ctx = llama_init_from_model(model, cp);
        if (!ctx) {
            llama_model_free(model);
            say(err, err_len, "the engine loaded %s but would not make a context", declared->path);
            return RE_MODEL_E_LOAD;
        }
    }

    auto *handle = new re_model();
    handle->model = model;
    handle->ctx   = ctx;

    const llama_vocab *vocab = llama_model_get_vocab(model);
    llama_model_desc(model, handle->identity.description, sizeof handle->identity.description);
    std::snprintf(handle->identity.digest, sizeof handle->identity.digest, "%s", actual);
    handle->identity.params      = llama_model_n_params(model);
    handle->identity.size_bytes  = llama_model_size(model);
    handle->identity.n_vocab     = vocab ? llama_vocab_n_tokens(vocab) : 0;
    handle->identity.n_ctx_train = llama_model_n_ctx_train(model);
    handle->identity.load_ms     = now_ms() - t0;
    handle->identity.resident_delta_bytes = resident_bytes() - rss0;

    *out = handle;
    return RE_MODEL_OK;
}

void re_model_close(re_model *model) {
    if (!model) return;
    if (model->ctx) llama_free(model->ctx);
    if (model->model) llama_model_free(model->model);
    delete model;
}

re_model_status re_model_attach_adapter(re_model *model, const char *path, const char *sha256,
                                        char *err, size_t err_len) {
    (void) model; (void) sha256;
    /* Refused by name rather than silently ignored. No adapter may exist before the training
       project's readiness gate is green, so a build that accepted one would be accepting something
       that cannot legitimately be on disk. */
    say(err, err_len, "adapters are not implemented in this build: %s cannot be attached",
        path ? path : "(no path)");
    return RE_MODEL_E_UNSUPPORTED;
}

void re_model_cancel(re_model *model) {
    if (model) model->cancel.store(true, std::memory_order_relaxed);
}

re_model_status re_model_identity_of(const re_model *model, re_model_identity *out) {
    if (!model || !out) return RE_MODEL_E_ARGS;
    *out = model->identity;
    return RE_MODEL_OK;
}

re_model_status re_model_run(re_model *model, const re_model_turn *turn,
                            re_model_counters *counters, char *err, size_t err_len) {
    if (!model || !turn || !turn->prompt) {
        say(err, err_len, "re_model_run: a model, a turn and a prompt are required");
        return RE_MODEL_E_ARGS;
    }
    if (!model->ctx) {
        say(err, err_len, "this model was opened vocab_only and has no weights to run");
        return RE_MODEL_E_UNSUPPORTED;
    }
    std::lock_guard<std::mutex> held(model->turn_lock);
    model->cancel.store(false, std::memory_order_relaxed);

    const llama_vocab *vocab = llama_model_get_vocab(model->model);
    re_model_counters local{};

    const int32_t prompt_len = (int32_t) std::strlen(turn->prompt);
    int32_t needed = -llama_tokenize(vocab, turn->prompt, prompt_len, nullptr, 0, true, true);
    if (needed <= 0) {
        say(err, err_len, "the prompt tokenised to nothing");
        return RE_MODEL_E_ARGS;
    }
    std::vector<llama_token> tokens((size_t) needed);
    if (llama_tokenize(vocab, turn->prompt, prompt_len, tokens.data(), needed, true, true) < 0) {
        say(err, err_len, "the prompt would not tokenise");
        return RE_MODEL_E_RUNTIME;
    }
    local.prompt_tokens = (int32_t) tokens.size();

    llama_sampler *smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
    if (turn->grammar && turn->grammar[0]) {
        llama_sampler *g = llama_sampler_init_grammar(vocab, turn->grammar, "root");
        if (!g) {
            llama_sampler_free(smpl);
            say(err, err_len, "the grammar would not compile");
            return RE_MODEL_E_ARGS;
        }
        llama_sampler_chain_add(smpl, g);
    }
    /* Temperature 0 is greedy, and greedy is the reproducible path: the determinism check depends
       on there being no sampling randomness at all, not on a fixed seed. */
    if (turn->temperature > 0.0f) {
        llama_sampler_chain_add(smpl, llama_sampler_init_temp(turn->temperature));
        llama_sampler_chain_add(smpl, llama_sampler_init_dist(LLAMA_DEFAULT_SEED));
    } else {
        llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
    }

    const double t_prompt = now_ms();
    llama_batch batch = llama_batch_get_one(tokens.data(), (int32_t) tokens.size());
    if (llama_decode(model->ctx, batch) != 0) {
        llama_sampler_free(smpl);
        say(err, err_len, "the engine would not evaluate the prompt");
        return RE_MODEL_E_RUNTIME;
    }
    local.prompt_ms = now_ms() - t_prompt;

    const int32_t budget = turn->max_tokens > 0 ? turn->max_tokens : 128;
    const double t_gen = now_ms();
    re_model_status status = RE_MODEL_OK;
    char piece[512];
    llama_token next = 0;

    for (int32_t produced = 0; produced < budget; produced++) {
        /* Checked BEFORE the token is sampled, so a cancel costs at most the token already in
           flight. That is the "within one token" the ABI promises. */
        if (model->cancel.load(std::memory_order_relaxed)) {
            local.cancelled = 1;
            status = RE_MODEL_E_CANCELLED;
            break;
        }
        next = llama_sampler_sample(smpl, model->ctx, -1);
        if (llama_vocab_is_eog(vocab, next)) break;

        const int32_t n = llama_token_to_piece(vocab, next, piece, (int32_t) sizeof piece, 0, false);
        if (n > 0 && turn->on_token) {
            if (turn->on_token(turn->user, piece, (size_t) n) != 0) {
                local.generated_tokens++;
                local.cancelled = 1;
                status = RE_MODEL_E_CANCELLED;
                break;
            }
        }
        local.generated_tokens++;

        llama_batch one = llama_batch_get_one(&next, 1);
        if (llama_decode(model->ctx, one) != 0) {
            llama_sampler_free(smpl);
            say(err, err_len, "the engine stopped part way through the turn");
            return RE_MODEL_E_RUNTIME;
        }
    }
    local.generate_ms = now_ms() - t_gen;
    llama_sampler_free(smpl);

    /* The context is cleared so the next turn is judged on its own prompt. Without this, a second
       run of the same prompt continues the first one and "identical tokens" would be measuring the
       wrong thing. */
    llama_memory_clear(llama_get_memory(model->ctx), true);

    if (counters) *counters = local;
    return status;
}

} // extern "C"

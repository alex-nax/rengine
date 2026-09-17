/* rengine::agent — the ABI's own checks.
 *
 * Two modes, because two different things are being asked and only one of them needs weights:
 *
 *   digest  the declaration rules. Runs anywhere, needs nothing, never skips.
 *   turn    determinism, cancellation and the counters. Needs a declared model on this machine,
 *           and SKIPS (exit 77) naming the prerequisite when there is none — never green.
 *
 * The fixture is declared, never fetched (charter D68): set RENGINE_AGENT_FIXTURE to a GGUF and
 * RENGINE_AGENT_FIXTURE_SHA256 to its digest.
 */
#include "rengine/model.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SKIP 77

static int failures = 0;

static void check(int ok, const char *what) {
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) failures++;
}

/* ---- digest: runs anywhere ---------------------------------------------------------------- */

static int digest_mode(void) {
    char tmp[] = "/tmp/rengine-agent-XXXXXX";
    int fd = mkstemp(tmp);
    if (fd < 0) { fprintf(stderr, "cannot create a temporary file\n"); return 1; }
    FILE *f = fdopen(fd, "wb");
    fputs("abc", f);
    fclose(f);

    char hex[65], err[512];
    check(re_model_file_digest(tmp, hex, err, sizeof err) == RE_MODEL_OK, "a file's digest is readable");
    /* The FIPS 180-4 vector for "abc", so this checks the implementation and not just itself. */
    check(strcmp(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") == 0,
          "and it is the SHA-256 the standard says it is");

    re_model *model = NULL;
    re_model_open declared;
    memset(&declared, 0, sizeof declared);
    declared.path = tmp;

    /* No digest at all: refused rather than defaulted to "open it anyway". */
    err[0] = '\0';
    declared.sha256 = NULL;
    check(re_model_open_declared(&declared, &model, err, sizeof err) == RE_MODEL_E_ARGS,
          "a declaration with no digest is refused");
    check(strstr(err, "sha256") != NULL, "and the refusal names what is missing");

    /* One hex digit changed: the file is no longer the file that was declared. */
    char wrong[65];
    memcpy(wrong, hex, sizeof wrong);
    wrong[0] = (char) (wrong[0] == 'a' ? 'b' : 'a');
    err[0] = '\0';
    declared.sha256 = wrong;
    check(re_model_open_declared(&declared, &model, err, sizeof err) == RE_MODEL_E_DIGEST,
          "a file that does not match its declaration is refused BEFORE it is loaded");
    check(strstr(err, wrong) != NULL && strstr(err, hex) != NULL,
          "and the refusal shows both the declared and the found digest");

    /* Malformed rather than merely wrong. */
    err[0] = '\0';
    declared.sha256 = "not-a-digest";
    check(re_model_open_declared(&declared, &model, err, sizeof err) == RE_MODEL_E_ARGS,
          "a malformed digest is refused as malformed, not as a mismatch");

    /* A path that is not there fails as a path, not as a digest. */
    err[0] = '\0';
    declared.path = "/tmp/rengine-agent-does-not-exist.gguf";
    declared.sha256 = hex;
    check(re_model_open_declared(&declared, &model, err, sizeof err) == RE_MODEL_E_ARGS,
          "a missing file is refused as a missing file");

    check(model == NULL, "nothing was opened by any of the refusals");
    remove(tmp);

    printf("engine: %s\n", re_model_engine_version());
    return failures ? 1 : 0;
}

/* ---- turn: needs a declared model ---------------------------------------------------------- */

struct collected {
    char text[4096];
    size_t len;
    int    stop_after;
    int    seen;
};

static int collect(void *user, const char *text, size_t len) {
    struct collected *c = (struct collected *) user;
    if (c->len + len < sizeof c->text) { memcpy(c->text + c->len, text, len); c->len += len; }
    c->seen++;
    return (c->stop_after && c->seen >= c->stop_after) ? 1 : 0;
}

static int turn_mode(void) {
    const char *path = getenv("RENGINE_AGENT_FIXTURE");
    const char *sha  = getenv("RENGINE_AGENT_FIXTURE_SHA256");
    if (!path || !sha) {
        printf("SKIP: no fixture model is declared on this machine.\n"
               "      Set RENGINE_AGENT_FIXTURE to a small generative GGUF and\n"
               "      RENGINE_AGENT_FIXTURE_SHA256 to its digest, which\n"
               "      `re_model_file_digest` will print. Weights are declared per machine and\n"
               "      never downloaded by this project.\n");
        return SKIP;
    }

    char err[512];
    re_model *model = NULL;
    re_model_open declared;
    memset(&declared, 0, sizeof declared);
    declared.path = path;
    declared.sha256 = sha;
    declared.gpu_layers = -1;
    declared.context = 512;

    if (re_model_open_declared(&declared, &model, err, sizeof err) != RE_MODEL_OK) {
        printf("FAIL the declared fixture would not open: %s\n", err);
        return 1;
    }

    re_model_identity id;
    check(re_model_identity_of(model, &id) == RE_MODEL_OK, "identity is reported");
    printf("     %s | %llu params | %d vocab | load %.0f ms | resident +%lld bytes\n",
           id.description, (unsigned long long) id.params, id.n_vocab, id.load_ms,
           (long long) id.resident_delta_bytes);
    check(strcmp(id.digest, sha) == 0, "and it echoes the digest that was verified");

    /* Determinism: greedy twice, same prompt, same tokens. */
    struct collected a, b;
    re_model_counters ca, cb;
    memset(&a, 0, sizeof a); memset(&b, 0, sizeof b);
    re_model_turn turn;
    memset(&turn, 0, sizeof turn);
    turn.prompt = "The capital of France is";
    turn.max_tokens = 16;
    turn.temperature = 0.0f;
    turn.on_token = collect;

    turn.user = &a;
    check(re_model_run(model, &turn, &ca, err, sizeof err) == RE_MODEL_OK, "a turn runs");
    turn.user = &b;
    check(re_model_run(model, &turn, &cb, err, sizeof err) == RE_MODEL_OK, "and runs again");
    check(a.len > 0 && a.len == b.len && memcmp(a.text, b.text, a.len) == 0,
          "temperature 0 produces identical tokens across two runs");
    printf("     produced %d tokens, %.1f tok/s generate, %.0f ms prompt\n",
           ca.generated_tokens,
           cb.generate_ms > 0 ? cb.generated_tokens * 1000.0 / cb.generate_ms : 0.0,
           cb.prompt_ms);

    /* Cancellation from inside the stream: stopping after one token costs exactly that token. */
    struct collected c;
    re_model_counters cc;
    memset(&c, 0, sizeof c);
    c.stop_after = 1;
    turn.user = &c;
    turn.max_tokens = 64;
    check(re_model_run(model, &turn, &cc, err, sizeof err) == RE_MODEL_E_CANCELLED,
          "a turn stopped from the callback reports cancelled");
    check(cc.cancelled == 1 && cc.generated_tokens == 1,
          "and stops within one token of the request");

    /* Adapters are refused by name rather than silently ignored. */
    err[0] = '\0';
    check(re_model_attach_adapter(model, "/tmp/none.gguf", sha, err, sizeof err) == RE_MODEL_E_UNSUPPORTED,
          "an adapter is refused by name in this build");

    re_model_close(model);
    return failures ? 1 : 0;
}

int main(int argc, char **argv) {
    const char *mode = argc > 1 ? argv[1] : "digest";
    if (strcmp(mode, "turn") == 0) return turn_mode();
    return digest_mode();
}

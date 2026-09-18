# Spec 151 — Jev: typed judgements in the harness

Owner request, 2026-09-18: *"So I got access to JEV… We want to have support of it at IDE level, i
think this should be operating as a plugin while it's experimental, then we will see if it can be
adopted at top level"*, with a usable key placed at `.jev` in the checkout.

Jev (typesafe.ai) answers typed questions about supplied state and returns **probabilities** rather
than prose. Their own use-case map names *Harness Engineering* — "model routing, guardrails,
reasoning-trace classification" — as a category, which is this project's daily work.

Status: **design; nothing implemented.** Rows F228–F231. Charter **D74**.

## What was measured, not read

All figures from the live API on 2026-09-18 with the owner's key, from the dev machine.

| | |
|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer` |
| Round trip | **0.56–0.70 s**, consistent across nine calls. The docs advertise 150 ms; the difference is network distance |
| Size | 425–474 input tokens for a realistic call; 1,500 for a large one |
| Price | **$42 per billion input tokens**, output free — about **$0.00002** a call. Fifty calls a day for a year is 36 cents |
| Limits | 1,200 requests/minute, 250k tokens/second, 64k context (32k for state plus the longest question) |
| Model | `jev-1.13.0`; `jev-latest` is an alias that moves |

**Cost is not the constraint and latency is.** 600 ms is fine for a judgement that runs when
something fails, and rules out anything on a keystroke or a frame — which the desktop's 32 MiB
budget and its lack of any network of its own already ruled out for other reasons.

### The three question types, and one trap

`noul` returns a probability and **no confidence field**. `choice` returns the pick, the full
distribution and confidence. `score` returns a level index, the distribution and confidence.

**`choice` takes its `criteria` as a map; `score` takes an ordered list.** Sending a map to a score
returns `422 {"msg":"Input should be a valid list"}`. Found by hitting it; encoded in the types so no
call site discovers it again.

### What it said about our own work

| question | answer |
|---|---|
| Is the `red-worker` socket failure a flake? | `noul 0.91`; verdict `treat_as_flake` at conf 0.74 |
| Which agent for the Windows porting task? | `claude` at conf 0.99 |
| Is the explorer change well evidenced? | level 2 of 4 at conf 1.00 — withheld the top level because no measurements were recorded |

The triage answer is the one that matters: it reached *flake* from the failure text alone, which is
the conclusion that cost three isolation runs by hand the same day.

## What the codebase already settled

Read before designing, and it removes most of the work:

- **Rust already makes outbound HTTPS to a third-party cloud API.** `red_core::tls::request` exists
  (rustls + native certs, blocking), and `red-project/src/tracker_remote.rs` and `tracker_auth.rs`
  use it to reach Linear. **Jev is not a new category of network access, and needs no new
  dependency.**
- **Third-party credentials live in the state directory**, not the checkout:
  `<state>/trackers/oauth.json`, put there by a person.
- **The desktop has no network of its own** and its budget is 32 MiB over the SDL baseline.
- **Plugin ABI v2** gives a plugin draw, clip, measure, theme colour, pointer inside its own tab, and
  `subject()` — the path of its tab's file. It has **no entry for network and no channel to receive
  data from the host**.

## Decisions

| # | Decision | Attribution |
|---|---|---|
| 1 | **The call is made by Rust, over the existing `red_core::tls::request`.** No new dependency, and the same path already used to reach Linear. This follows D57 and D68's shape — the surfaces a person touches are C, the network is Rust. | Owner, 2026-09-18, choosing "a Rust service" in a design interview |
| 2 | **The key lives in the state directory**, beside the tracker credentials, and the service reads a declared path. `.jev` in the checkout is gitignored as of this spec — it was **not**, and sat one `git add -A` from being committed. The key is never logged, never echoed in a refusal, and never crosses into the desktop process. | The `trackers/oauth.json` precedent |
| 3 | **Capabilities are named and closed, and their parameters are identifiers, never free text.** There is no generic "ask Jev" tool: a generic tool would let any agent send anything. Each capability owns its question set and a state builder that may read only the sources it declares — and the caller passes **ids and paths from a closed set**, never a string. The motivating capability is the one that proves why: triage naturally wants the failure *text*, and a text parameter is a hole the size of the whole boundary. | Recommended; corrected by review finding 5 |
| 3b | **The boundary disciplines the sanctioned path and does not contain a determined agent.** Agents here run as the owner's UID with filesystem access, so one that reads the key can call the API directly, bypassing capabilities, ceilings and the record; `0600` does not change that, and there is no egress control to route around. This is recorded rather than papered over: the audit trail is the call record plus the vendor's own usage log, and the claim is "the allowlist disciplines what the tools do", not "the allowlist is a sandbox". | Review finding 5 |
| 4 | **v1 sends only text this project already writes down** — failure output, feature rows, known issues — **and a scrub pass runs over it before it leaves.** "Already written down" is not the same as "safe to send", and this repository proves it: `pr0fe@192.168.31.217`, a private host, appears in the charter, in `features.json` three times and in spec 147. Failure output carries absolute paths, usernames and internal topology. Each state builder declares a scrub, and an unscrubbed builder is refused. The two candidates that would send source are **named and deferred**. | Conservative reading; scrub added by review finding 8 |
| 5 | **Shadow mode first: nothing acts on a judgement until the thresholds have been measured.** Every capability is record-only until it has N outcomes, and only then are bands set from that calibration. This reverses the first draft, which fixed thresholds at design time and then proposed to score the tool against those same hand-set numbers — circular, as the review said. | Review finding 3 |
| 5b | **Gate on the distribution, not the vendor's scalar.** `choice` and `score` return full probabilities; the top-1 to top-2 **margin** is computable and is what gets gated. The scalar `confidence` is recorded but not gated on — the spec's own probe watched it collapse 0.69 → 0.29 on one decision when a framing clause was removed, and the measured example `level 2 of 4 at conf 1.00` is a self-assessed certainty on a judgement call. For `noul`, distance from 0.5 is **not** used as a confidence proxy: it measures how decisively the model picked, and a model forced to answer an ill-posed question answers extremely. A noul capability gates on agreement across a repeat ask instead. | Review finding 3 |
| 5c | **"Act" is enumerated per capability, and for the readiness gate it can only mean *file*, never *assert*.** `passes: true` requires evidence for every criterion (AGENTS.md) and D47's shape is that rEngine files a judgement and the owning project decides. A cloud probability is a judgement about evidence, not evidence. So the readiness capability may open a row or record a dissent; it may never set or block `passes`. | Review finding 4 |
| 6 | **Every call is recorded, and every judgement later carries what actually happened.** The call record holds capability, question ids, answers, probabilities, confidence, input tokens and the **versioned model id**; each row then gains an `outcome` — accepted, overridden, confirmed by an isolation run, row later reverted. Without the outcome the record measures usage and not accuracy, and F231 could not decide anything from it. The record lives in the state directory with the key, never in the checkout: it contains failure output. | Corrected by review finding 1, the most serious |
| 7 | **The model is pinned by version**, `jev-1.13.0`, not by the `jev-latest` alias, so thresholds tuned against one model are not silently moved by a release. | Their own guidance |
| 8 | **REVERSED by review: the IDE surface moves no ABI version.** The first draft proposed ABI v3 for a host-to-plugin data channel. That is wrong by spec 106's own rule — `size` on every struct exists precisely so "a later ABI that only *adds* members can keep its number" — and the exact-match rule in its decision 1 would make a bump a flag day refusing every existing plugin, for an experiment designed to be discardable. It is also the wrong shape: a generic document the host hands the frame is the first host-table entry that is a **data pipe rather than a capability**, which launders D38's "the struct is the grant" into "the host serialises what it likes". Instead the judgement record is workspace state the host already serves, rendered in a desktop-owned view over the channel that exists (`editor/net.c` → `/api/*`, the path tracker rows already travel). **Zero ABI movement.** If the experiment proves out and a bespoke plugin surface earns it, one entry is appended under the `size` rule — with evidence, and by then not on an experiment's word. | Review finding 2 |
| 9 | **Nothing calls Jev on a timer or a keystroke**, and every trigger names how it reaches the service. The harness triggers live in stdlib-only Python and in git, not in any Rust event stream, so each is an explicit `red-jev` subcommand the gate shells out to, or an MCP tool a person or agent invokes deliberately — which also makes every call intentional. A per-session ceiling is declared, enforced by name and visible. | Trigger plumbing named after review finding 7 |
| 10 | **A gate fails open, loudly.** `red_core::tls::request` blocks up to 30 s; when the judge is down, slow or rate-limiting, a local gate must not become hostage to a third party's uptime. The call is bounded well under that, and an unavailable judge is recorded as *judge unavailable* and the gate proceeds — visibly, never silently. The 1,200 req/min limit is **per key**, shared with anything else pointed at it, which is the lesson `tracker_remote.rs` already wrote down. | Review finding 6 |
| 11 | **Identical questions are coalesced and repeated ones must agree.** A `(capability, state-hash)` pair answered within a window is served from the record rather than paid for twice — pinning the model does not pin decoding, so asking twice can answer twice differently. Where a noul capability gates, the repeat ask is required to agree. State over the 32k budget is refused by name, never silently truncated: silent truncation changes the question. A recorded response fixture per capability guards the vendor changing shapes under us — the one API-shape fact in this spec, the `422` list-versus-map trap, was found by experiment and not by contract. | Review finding 9 |

## The open question this spec assumes an answer to

**What may be sent to a third-party judge is not settled**, and decision 4 takes the conservative
reading so the work can start. The owner was asked and said to go on; this is the assumption, stated
so it is cheap to reverse:

> v1 sends only content the project already records in its own files. No source, no diffs, and
> nothing from a consuming project.

Jev's own answer, asked twice under deliberately different framings, is the reason to trust the
narrow half of this and not the wide half: `everything_including_source` scored **0.00 both times**,
while the policy question itself came back at **confidence 0.25–0.27** — by their own three-band
guidance, "route to a human". It declined to make the values call, which is the correct behaviour and
leaves it with the owner.

## What this does not do

- It does not send source, diffs, or any consuming project's content.
- It does not put a generic Jev tool in front of an agent.
- It does not make the desktop talk to the network.
- It does not claim the experiment succeeded: F231 is the row that decides adoption, on the record
  decision 6 produces.

## The review, and what it changed

A read-only cross-vendor review (kimi, 2026-09-18) over this spec and the tree it lands in, asked to
find where the design is wrong rather than where it is agreeable. It returned **CHANGES REQUESTED**
and eleven findings. What each did to this spec:

| # | Finding | Disposition |
|---|---|---|
| 1 | **The experiment could not decide anything**: the record held question, answer, confidence and tokens — but no outcome, so it measured usage and not accuracy. | **Accepted, most serious.** Decision 6 gains an outcome per judgement; F231 gains a metric registered before the first call. |
| 2 | **ABI v3 was wrong by spec 106's own rule** (`size` exists so additive members keep the number), its exact-match rule would make a bump a flag day, and a host-hands-the-frame document is a data pipe laundering D38's "the struct is the grant". | **Accepted; decision 8 reversed.** Verified at `106-plugin-abi.md:80` and its decision 1. The view is served over `editor/net.c` → `/api/*` with zero ABI movement. |
| 3 | **The gate stood on a signal this spec had just shown unstable** (0.69 → 0.29 on a framing change), `noul`'s distance-from-0.5 conflates decisiveness with trust, and thresholds set by feel would be scored against themselves. | **Accepted.** Decisions 5, 5b: shadow mode until calibrated, gate on distribution margin, noul gates on repeat agreement. |
| 4 | **"Act" was undefined** and its natural reading collides with the `passes` rule and D47. | **Accepted.** Decision 5c: the readiness capability may file, never assert. |
| 5 | **The boundary had a free-text hole** — triage naturally takes failure *text* — and the key is readable by any same-UID agent. | **Accepted.** Decision 3: parameters are ids from a closed set. Decision 3b records the residual risk instead of claiming a sandbox. |
| 6 | **Failure behaviour unspecified** for a 30-second blocking third-party call inside a local gate; the rate limit is per key. | **Accepted.** Decision 10: fail open, loudly. |
| 7 | **No trigger plumbing**: the triggers live in stdlib-only Python, not a Rust event stream. | **Accepted.** Decision 9 names the invocation per trigger. |
| 8 | **"Already written down" ≠ safe to send.** | **Accepted, and proven by this repository**: `pr0fe@192.168.31.217` is in the charter, in `features.json` three times, and in spec 147. Decision 4 gains a scrub. |
| 9 | Dedup, 32k truncation, record location, vendor-shape drift. | **Accepted.** Decision 11. |
| 10 | **The strategic comparison was missing**: this project's committed direction is a local model (D68/D73). | **Accepted.** F231 must attempt the same classifications locally and record both. |
| 11 | D74 and F228–F231 were cited as recorded when they were not. | **True when read, fixed by timing** — both were written after the review began. Recorded because the reviewer was right about the ordering: a spec should not cite authority it has not created. |

Two of the reviewer's own framings were checked rather than taken: spec 106's `size` rule and the
private host both verified in the tree before the changes above were made.

## A note on asking Jev about its own integration

The decisions above were put to Jev. Two answers held under a counter-framing and two did not:
`plugin_self_io_acceptable` moved **0.19 → 0.61** and the route recommendation's confidence collapsed
**0.69 → 0.29** once a leading clause about the ABI's intent was removed. Those two were the author's
framing reflected back, and are **not** cited as evidence anywhere in this spec — decision 1 rests on
D57 and the Linear precedent instead. The scope answer (0.86/0.82) and the source refusal (0.00/0.00)
held under both framings and are cited.

Recorded because it is the method, not the result, that transfers: **a judgement model asked about a
decision you have already framed will often return your own framing, and the way to find out is to
ask again with the framing removed.**

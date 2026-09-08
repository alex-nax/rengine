# A paste reaches the PTY whole (KI-070)

Date: 2026-09-08. Status: **implemented and measured.** Reported by the owner:

> I think somethink is with copying large portions of text to our editor, the performance around it
> is terrible and only a small portion of text is being copied

Two symptoms, one cause, found by reading the path rather than guessing at it.

## The mechanism

`vterm_keyboard_unichar` is called **once per character** — for a paste at `terminal.c:219`, and for
typed text at `:210`. Every call reaches the output callback, which built a cJSON object, serialised
it, and queued **its own socket message**:

```c
static void output(const char *bytes, size_t size, void *user) {
  ReTerminal *t = user; if (t->mute_output) return;
  char *text = malloc(size + 1); ...
  cJSON *j = cJSON_CreateObject(); ... cJSON_AddStringToObject(j, "data", text);
  free(text); send(t, j);            /* one message per character */
}
```

The outgoing queue is bounded at **`RE_NET_QUEUE 128`** (`net.c:5`). `push` refuses past it,
`re_socket_send` returns false — and `output` never looked at the return value, so the message was
freed and the characters vanished. Silently.

So a paste longer than roughly 128 characters lost everything past what the network thread had
drained by then. That is both reported symptoms at once: the malloc/JSON/serialise/send per
character is the "terrible performance", and the queue refusing at 128 is the "only a small portion".

**Measured, not inferred.** With the counters in place but the batching removed, a 31-character
burst produced **31 messages**:

```
Expected one message for a 31-byte burst, got 31
```

## The fix

Bytes from one event are gathered in the terminal and leave together. `output` appends to a growable
buffer; `flush_output` sends it; every public entry point that can make vterm emit — event, mouse,
release, message — runs its handler and then flushes. The handlers became statics so that the early
`return`s inside them cannot skip the flush.

Semantics are unchanged: the bytes still leave within the same call, in the same order. There are
just far fewer messages carrying them.

### Why it is chunked rather than one message

The obvious version — one message per event — would have been worse than the bug for a large enough
paste. The session host reads these with **`maxPayload: 2 * 1024 * 1024`** (`server/main.mjs:140`),
and `ws` **closes the connection** on an oversized frame. An unbounded paste would have cost the
session rather than the tail of the text.

`RE_TERMINAL_CHUNK` is 128 KiB. JSON escaping can turn one control byte into six characters, so even
at worst-case escaping a chunk stays far under 2 MB.

### The UTF-8 boundary

Splitting a multi-byte sequence would leave invalid UTF-8 on both sides of the cut, and cJSON does
not validate, so the damage would travel into the PTY. `flush_output` walks the split point back off
any continuation byte (`(b & 0xC0) == 0x80`).

## Evidence

**RED**, with the batching removed and the counters kept — so the failure is the batching's absence
and nothing else: `Expected one message for a 31-byte burst, got 31`.

**GREEN**: `native_terminal` passes; the burst produces one message carrying every byte. The test
uses multi-byte text (`abcéééédef世界ghijkl`, 26 bytes) so that a batching change which mangled
UTF-8 would show up in the byte count.

**The chunk boundary is not reachable from the test harness** — it needs a >128 KiB buffer and the
paste path needs a clipboard the headless test does not have. It was verified directly instead, by
temporarily setting `RE_TERMINAL_CHUNK` to 8 and printing each chunk:

```
CHUNK take=7 first=0x61     'a'  — ASCII lead
CHUNK take=7 first=0xc3     é    — 2-byte lead
CHUNK take=8 first=0xe4     世   — 3-byte lead
CHUNK take=4 first=0x69     'i'  — ASCII lead
```

26 bytes in, 26 bytes out, and **no chunk begins on a continuation byte** (`0x80`–`0xBF`). A naive
split would have produced 8, 8, 8, 2 with two chunks starting mid-sequence; the backoff produced
7, 7, 8, 4. The constant was restored to 128 KiB afterwards.

Gates: native suite 8/8, `npm test` 223/223, `design.py check` clean.

## What this does not fix

- **The drop is now counted, not surfaced.** `re_terminal_inspect_output` reports
  `outputMessages` / `outputBytes` / `outputDropped`, but a refused `re_socket_send` still does not
  reach the person who pasted. With batching the queue is far harder to overrun, so this is much
  less likely — it is not impossible, and a silent loss is what made the original bug invisible for
  as long as it was.
- **The editor pane's own large-paste cost.** `editor.c:228` drops the whole syntax line-state cache
  on every revision (`state_count = 0`) and rescans from the top to the scroll position, so editing
  far down a large file re-scans on each keystroke. That is a real cost, it is *not* what was
  reported here — there is no truncation on that path, the paste itself is a single `stb` insert —
  and it is left for its own slice.
- **Whether the owner meant a terminal pane.** The truncation symptom only has one source, and this
  is it. If a file editor pane also drops text, that is a different defect and this spec does not
  cover it.

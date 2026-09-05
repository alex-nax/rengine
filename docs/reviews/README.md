# Roadmap review artifacts

Open [the roadmap review](rengine-roadmap-2026-09-05-v1.html) in a browser. It embeds all 54
proposed features, their complete acceptance criteria, owners and dependencies, grouped into
six branches. Confirmed interview decisions are context, not questions to answer again.

Select a verdict for each proposed branch, leave feature-specific comments where needed and
use **Save JSON**. The expected decision filename is `rengine-roadmap-2026-09-05-v1.json`; the
browser may download it rather than saving beside the HTML. Chat feedback is also valid. The
spec input (`.spec.json`) is generated content, not owner feedback, and must never be read as
an approval. Missing verdicts, deferred sections and default controls are not approval.

The review accepts scope and dependencies; it does not satisfy feature acceptance criteria,
prove external integrations, or grant blanket execution authority in sibling workspaces.
Resolve requested revisions and dependency closure before activating accepted scope in
`features.json`. Preserve the remaining proposals and record the owner review and exact source
hashes. The input's `source_sha256` map identifies the documents and inventory under review.
If those sources change, regenerate a new review version and reconcile prior feedback explicitly.

## Reproduction and provenance

The source is `rengine-roadmap-2026-09-05-v1.spec.json`. Generate it with the installed ispec skill:

```sh
python3 /Users/alex/.agents/skills/ispec/scripts/ispec_gen.py \
  docs/reviews/rengine-roadmap-2026-09-05-v1.spec.json \
  -o docs/reviews/rengine-roadmap-2026-09-05-v1.html
```

`assets: "copy"` includes unmodified `ispec.css` and `ispec.js` from that skill's `references/`
directory. They are review tooling, not the desktop orchestrator implementation. The checked-in
HTML and adjacent assets work without the skill installed or a network connection; the command
above is only for local regeneration. Do not customize the shared engine in this snapshot.

Validation covers source hashes, one-to-one coverage of all proposed features, HTML section/control
structure, relative assets, JavaScript syntax, document links and roadmap dependency boundaries.
The in-app browser was unavailable during setup, so automated visual/control/export verification
was not performed. The review opens in the regular browser for owner interaction.

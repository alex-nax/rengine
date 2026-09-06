---
name: grill-me
description: Relentlessly interview the owner about a plan, design, or feature until shared understanding is reached — walking each branch of the design tree and resolving dependencies between decisions one by one, with a recommended answer attached to every question. USE THIS SKILL whenever the user says "grill me", "/grill-me", "interview me about this", "walk me through the decisions", or asks to be questioned before an implementation; also use it proactively before building anything where the design space is wide and a wrong guess is expensive (a renderer or adapter boundary, a persisted format, a UX with several plausible shapes, anything a game or the Claude Design source depends on).
---

# Grill me — design interview until shared understanding

Source: aihero.dev "grill me", adopted in nolf-improved on 2026-07-27 after a feature shipped on a
plausible-but-wrong design decision and had to be rebuilt from a device verdict; copied into
rEngine on 2026-09-06 at the owner's request before F57.

The core prompt, verbatim:

> Interview me relentlessly about every aspect of this plan until we reach a shared
> understanding. Walk down each branch of the design tree resolving dependencies between
> decisions one by one.
>
> If a question can be answered by exploring the codebase, explore the codebase instead.
>
> For each question, provide your recommended answer.

## How to run it here

1. **Build the design tree first, privately.** List the decisions and their dependency
   order — which answers gate which other questions. Ask in that order; never ask a
   question whose premise depends on an unanswered one.
2. **Codebase before owner.** If the repo, a pinned dependency, an evidence document, the
   charter decision table, or a prior spec already answers a question, go read it and don't
   ask. Cite what you found instead. The owner's time goes to genuine judgment calls only.
3. **Every question carries a recommendation.** Use AskUserQuestion with the recommended
   option FIRST and marked "(Recommended)", with a reason in its description. The owner
   should be able to confirm with one click when the recommendation is right.
4. **Small rounds, sequential.** 2–4 tightly related questions per round (one branch of
   the tree), then the next round built on the answers. Not one giant batch — later
   questions must be allowed to change shape based on earlier answers.
5. **Answers can invalidate the tree.** When an answer prunes or reshapes a branch, say
   so and re-plan before the next round.
6. **Stop at shared understanding, then write it down.** End with a summary of every
   decision, each attributed (owner-decided vs recommended-and-confirmed vs
   codebase-derived), and record it in the feature's spec under `docs/specs/` before any
   implementation starts. Decisions that reverse an earlier recorded decision must say so
   explicitly.

## rEngine notes

- The spec is the artifact. A grill session that doesn't end in a spec update didn't
  happen. Check `ls docs/specs` **and** `git status --short docs/specs` before choosing a
  number: a parallel session in the native orchestrator creates untracked specs.
- Native evidence outranks paper reasoning: smoke snapshots, CTest, the native desktop
  suite and measured budgets set before the run. When a question is really "how will this
  look or perform on the desktop", say so in the recommendation and prefer designs that are
  cheap to A/B behind an explicit switch (`--renderer`, an environment variable, a token).
- Decisions that change a boundary or an owner requirement also go into the charter's
  decision table (`docs/specs/000-charter.md`, next D-number, owner quote and date) and, when
  they bind future agents, into `AGENTS.md`. Feature criteria stay stable; add follow-up
  rows instead of reworded requirements (`AGENTS.md` work protocol).
- Design questions about appearance are answered by the Claude Design source in `design/`
  (`tokens.css`, cards) and `python3 tools/design.py resolve <preset>`; rendering questions by
  specs 066–067. Do not ask the owner what those already state.
- The recommendation must be a genuine position, not a hedge — its track record is the
  point. If you have no basis to recommend, that is itself the finding: go do the
  research (codebase, pinned SDK headers, evidence docs, web) and come back.

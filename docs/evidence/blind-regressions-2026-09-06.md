# Three regression tests that proved nothing — 2026-09-06

Three tests added on one day passed their reviews, passed in the suite, and could not have failed
for the reason they existed. They were found within about an hour of each other by two sessions
working in different parts of the desktop, which is what makes this a pattern about how tests are
written here rather than three unrelated mistakes. Two more of the same shape arrived from a peer session before the day was
out, and one of a different shape: a fixture that stopped running altogether.

This document records the cases and the rule they support. The owner took the rule into the work
protocol in `AGENTS.md` on 2026-09-06; this is the evidence it rests on.

## The three cases

| # | Test | Why it could not fail | Found by |
| --- | --- | --- | --- |
| 1 | A device row pressed while a probe is in flight, asserting the surface stays clickable | The surface was opened once, and a surface opened for the first time is already the frontmost container. The ordering never exercised the case the fix addresses. | vtmb-vr session, in its own lane |
| 2 | The settings popover stays clickable after a pane has been used | The pane being pressed had no tab in it, so there was no container for the press to bring forward and the surface stayed in front either way. Every line of the test was correct. | This session, prompted by case 1 |
| 3 | The accent slider's track is a gradient | The track is drawn as twelve segments, one per hue step, and the assertion counted distinct colours across the whole track. Twelve flat segments are still twelve colours, so the gradient primitive could be broken on every adapter with the suite green. | This session, auditing after case 2 |

Case 2 is an accident of the fixture, discoverable by asking what the fixture contains. Case 3 is
structural: the control under test masked the failure of the thing under test, and no amount of
reading the assertions reveals it, because the assertions are correct.

## What each one became

- Case 2 began discriminating only when the pane was given a terminal for an unrelated reason. It is
  now verified failing with `mu_bring_to_front` removed.
- Case 3 now samples two points inside a single segment, where nothing but interpolation can produce
  a difference. Verified failing with the primitive's second stop ignored.

## The sharpest case, which is not one of the three

The vtmb-vr session's cooperative-surface lane has an assertion of the same shape, reported here
rather than verified by this session: a cooperative launch environment must carry no injection
variable at all. It exists because a consumer declaring the wrong surface value would let an
injected client and the game's own client greet the same surface token, and the workspace would
destroy whichever socket arrived second, so the two race.

The failure worth catching is not a missing branch. It is a future edit that reintroduces injection
on that one path while everything else stays correct. A test that only goes red when the cooperative
branch is deleted sits green straight through exactly that edit. The sabotage therefore has to be
adding the variable back on that path.

It is the case worth leading with because of what the two failures look like. A cosmetic assertion
passing for the wrong reason shows up the moment someone looks at the screen. This one shows up as
an intermittent black pane, months later, in a build nobody has changed.

## Two more from the cooperative lane, reported the same day

Both are the peer session's, reported here, and both survived review:

- Its injection-race assertion was **masked**. The realistic sabotage tripped an earlier assertion
  first, so the test went red for the wrong reason and looked verified. It now stands alone and
  asserts the absence before the surface variables are set.
- Its viewer check passed with the frame fan-out removed entirely, because attaching replays the
  latest frame. It now demands two frames with different sequence numbers.

Neither would have been found by removing the fix and watching red.

## A different shape: the test that left

Not every silent gap is a blind assertion. Commit `9e52352` replaced `native-recording.spec.mjs`
with `native-explorer.spec.mjs` in the desktop suite instead of adding it. The cause was a stash
conflict on the single-line script resolved by taking whichever side contained the new entry, which
discarded the other side's addition. The recording fixture stopped running and the report stayed
green, because a suite says nothing about what it is no longer being asked.

That is the same family and the worst-lit corner of it: a blind test at least runs. This one does
not, and no report mentions its absence.

`orchestrator/tests/suite-coverage.test.mjs` now closes it. Every spec in the tree must be run by an
npm script or listed in an explicit allowlist with a reason, so removing one from the suite becomes
a visible edit in a reviewed file rather than a deletion inside a long single line. The allowlist is
checked for rot in the same test. Verified by reproducing the exact edit: the guard fails and names
the spec that left.

The audit it enabled found two specs that no script runs, both correctly excluded and now recorded
with their reasons: one needs an environment variable naming a trusted project with a real agent CLI,
the other needs a separately built surface fixture.

## The rule

Removing the fix and watching the test go red is necessary and not sufficient. Deleting the whole
slider would have turned case 3 red while teaching nothing about the gradient.

**The sabotage has to be the specific failure the test claims to prevent.** For case 3 that is
ignoring the second colour stop, not removing the control. For a test asserting that a cooperative
launch environment carries no injection variable, it is adding the variable back on that one path,
not deleting the cooperative branch.

A regression test that has never been observed failing for its own reason is an assertion about the
future with no evidence behind it, and the failure mode is silent, permanent, and invisible in every
report that says the suite is green.

## Audit run the same day

Every regression added in this session was checked by breaking the implementation in the specific
way each test claims to catch:

| Test | Sabotage | Result |
| --- | --- | --- |
| Scrolling a view repaints nothing above it | Container clip not applied in the control layer | fails, names the pixels |
| The popover takes clicks over a pane with mouse reporting | Overlay pointer ownership removed | fails |
| The popover stays clickable after a pane press | `mu_bring_to_front` removed | fails |
| The check mark keeps clear of its box corners | Mark drawn at the text size again | fails |
| A theme file overrides all three token layers | File parses but applies no colour | fails |
| A select opens a list | Select cycles to the next value again | fails |
| Expansion survives a reload | Reload clears the expansions | fails |
| Two scaffolded projects do not share one workspace | Per-checkout state directory removed | fails on both assertions |
| The accent track is a gradient | Second colour stop ignored | passed — fixed, now fails |
| Every desktop spec runs somewhere | A spec swapped out of the suite list | fails, names the spec that left |

The explorer and row-cap tests were red for their own reasons while the feature was built, so they
carry that evidence already.

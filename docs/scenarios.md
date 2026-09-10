# Scenarios — the canonical examples, fleshed out

> Status: **shipped 2026-09-08**, field repros S30–S32 + the display
> contract added 2026-09-09, gap-fill S33–S38 added 2026-09-10 —
> tests/scenario_tests.cc (38 scenarios, all green) over the harness in
> tests/scenario_utils.h. Run alone with
> `CelestrianTests --category=Scenarios` (the display-contract capture
> runs in the same category and writes shared/display_contract_capture.json
> for ui/js/tests/display_contract.test.mjs). Companions: recording.md
> §Examples, composition.md §7, design_language.md §3, sequencer.md,
> takes.md, time_maps.md.

## 0. What a scenario is

A short performance driven through the REAL engine (device callback,
512-sample blocks) with a **ramp input** — every input sample encodes
its own clock — so any committed sample says when it was captured, and
the island's output can be checked against an **analytic expectation**
composed from the laws below. No pan, gain or latency constant leaks
in (center is unity; the harness has no device latency). A failure is a
kernel bug or an expectation that needs a ruling — never a number to
be "fixed" to match the code.

Q = 20000 samples throughout. "NQ" = N × Q samples of committed content.

The laws the expectations are built from:

| law | where | expectation form |
|---|---|---|
| harness | S1 | `content[k] == input(capture_boundary + k)`; output = Σ sounding clips |
| plain loop | kernel.md §2 | clip sounds `content[(t − origin) mod D]` |
| window | time_maps.md §2 | `content[ws + ((t − origin − ws) mod len)]` |
| one-shot | design_language Q5 | sounds `content[h]` for `h = (t − origin) mod cycle < D`, else rest |
| group map | composition.md §2 | members read `t' = O + inner_G(t)` |
| period law | composition.md §3, period_law.h | cycle = lcm(Q, own(root)); own = map ▸ song ▸ content; one-shots contribute 0 |
| arm | design_language Q11 | origin = the next Q boundary after the click (the pickup) |
| origin | clip_node.cc | the stored origin IS the capture boundary — never folded (ruling 2026-09-09, reversing Q15) |
| song anchor | stack_node.cc renderChildren | a song's steps fold from the owner's frame origin: the epoch for the root (never anchored), the group's Q18 origin for a group; the display draws from the same place |
| epoch re-base | recording.md Q14b | on growth, epoch := epoch + floor((origin − epoch)/C_old)·C_old |
| Q13 | design_language Q13 | sole definer trim: Q := len, epoch := origin' + start; second arm collapses; re-open uncollapses |
| gates / cues | sequencer.md §3, §5 | gate = 10 ms ramps (checked away from seams); cue: `t' = O + (srel − stepStart)` |

Two grid gotchas worth stating once (they caught two draft scenarios):
a take pads forward to the **Q grid the first take established**, so a
3Q take on a 4Q island is a 4Q take; and a group's members inherit the
island's Q, not the group's.

## 1. The catalog

| # | scenario | steps | pins |
|---|---|---|---|
| S1 | first take defines Q | 1Q; then 3Q armed mid-cycle | Q := L1; origin = epoch; the second origin on the grid; pad to 3Q; cycle 3Q; the render is Σ loops |
| S2 | recording.md Example 2 | 1Q, 4Q, then an 8Q take armed at phase 2Q | origin ≡ 2Q (mod 4Q); cycle 8Q; **epoch re-base** to the heard top; content[0] at t ≡ origin; content[6Q] at the frame top |
| S3 | the owner's chain | 1Q, 5Q, 3Q; window c3 [1Q,2Q); 12Q; window c4 [0,6Q) | cycles 15Q → 5Q → 60Q → 30Q; Q untouched; both windows loop in place; c4's origin = its capture boundary (no fold) |
| S4 | LCM growth | 1Q,4Q,3Q,8Q,2Q | 4Q, 12Q, 24Q, 24Q (2Q does not shrink) |
| S5 | the pickup (E-A) | click within a block of the 4Q top; 8Q take | lands ON the next top; simple extension: epoch := origin |
| S6 | one-shot (Example 3) | 1Q at phase 3Q of 4Q, periodSource=context | cycle stays 4Q; fires at [3Q,4Q) only; back to a loop: every Q |
| S7 | window changes period (E-C) | [1Q,3Q) on the 4Q clip | cycle 2Q; bypass → 4Q; re-activate → 2Q |
| S8 | nested composite (E-B/E-C) | 1Q, 4Q; group with 2Q + 3Q; window group [2Q,4Q) | group intrinsic 6Q; island 12Q; windowed: 4Q and members read the mapped clock |
| S9 | Q13 sole definer | 4Q alone; window [1Q,2Q); second take; delete it; undo | Q := 1Q, epoch := origin'+start, phase-preserving; collapse: D := 1Q, origin += 1Q, window consumed, audio-neutral; re-open restores 4Q + trim; undo re-collapses |
| S10 | Q13 for groups | 2-mic 4Q group; stack window [1Q,2Q); a 1Q take | Q := 1Q; members whole; group collapse moves the subtree by 1Q; audio-neutral |
| S11 | Q survives its creator | 1Q, 4Q; delete 1Q; record 3Q; delete all; undo | Q stays; the grid stays; empty island has no Q; undo brings it back |
| S12 | seek | Example 2 state; seek to 5Q; undo | masterPos 5Q; every origin rides the epoch delta; render invariant; undo after seek strips the take |
| S13 | undo/redo the whole chain | S3; undo all; redo all | empty island (no Q, no nodes) ↔ identical facts and render |
| S14 | session round trip | S3; save; load in a fresh engine | identical facts, epoch, and render |
| S15 | takes and comping | new take on the 4Q slot; select; comp [0,1,0,1]; delete take | arms at the slot top; two takes; swap is sample-exact; the comp alternates per Q cell, seam-exact; delete renumbers, cells fall back |
| S16 | retake cancel | stop the new take after 1Q of 4Q | cancelled: one take; the previous sounds |
| S17 | sequencer period law | root song 4Q+4Q over 1Q+4Q; gate c2 off in step 2 | cycle 8Q; c2 silent in step 2 (outside the 10 ms ramps); bypass → 4Q |
| S18 | cue step | root song 4Q + 4Q(cue) over a 4Q clip | step 2 replays the song-top content |
| S19 | record over the song | root song 3Q+2Q over 1Q; record 3Q | cycle 5Q; the take's contextCycle = the song |
| S20 | successors | A→B→A; then A→A | 4Q song; 2Q song (B never visited); children's clocks untouched |
| S21 | combine / explode | 1Q, 4Q, 4Q@2Q; combine; undo | group anchored at the earliest member; nothing moves; explode restores |
| S22 | mute is a gain | mute 2.3Q, unmute | phase continuous |
| S23 | bounce == live | S3; bounce the root | the WAV is the live equation from the epoch, sample for sample |
| S24 | Q-coherence | windows of 1.5Q, 2Q, Q/2 on a 4Q clip | 1.5Q refused; 2Q and Q/2 accepted |
| S25 | one-shot group (G-2) | 1Q, 4Q; 2-mic 2Q kit at 2Q; periodSource=context | cycle 4Q; fires at [2Q,4Q) from its origin |
| S26 | the live-take gate | 4Q + 1Q; arm a third; try a window, a delete, a sequence, a period source, undo, pause, mute, rename; stop | every edit refused (undo entry kept, still playing); mute and rename live; all work again after the commit |
| S27 | one take at a time | arm c3; arm c4; new take on c2; stop; arm c4 | the second arm and the new take are refused; the next arm is accepted once settled |
| S28 | content cannot be a one-shot | one-shot on the sole take; then with a loop beside it; a group of every take | refused; allowed; refused |
| S29 | record INTO a windowed group | 1Q; group with a 4Q member windowed [1Q,3Q); arm an empty member | one map pass auto-finishes; D = the inner cycle 4Q; contextCycle = 2Q; through the map it replays what was heard; bypassed: content where played, silence elsewhere |
| S30 | **field repro**: the root song's grid | 1Q, 4Q; an 8Q take at 2Q after a full cycle (epoch re-bases); root song 4Q+4Q gating c1 off in step 2 | the root is never anchored; c1 is silent in step 2 of the EPOCH frame — the grid the ruler draws |
| S31 | **field repro**: a group song's grid | 1Q, 4Q; a group anchored at 2Q with a 4Q member; group song 4Q+4Q gating it off in step 2 | the group song folds from the GROUP's origin (2Q past the epoch), not the epoch; the lanes carry that phase (view_model `phaseQ`) |
| S32 | **field repro**: no origin fold | 1Q, 4Q windowed [1Q,3Q) (heard 2Q); a 3Q take armed at intrinsic phase 3Q | origin = the capture boundary; after the take the phrase continues from content[0], never mid-phrase |
| display contract | tests/display_contract_tests.cc → ui/js/tests/display_contract.test.mjs | S30 + S31 in one island; each gated clip SOLOED and listened to per Q cell | the audible truth table is dumped with the published state; the real deriveViewModel must dim every lane exactly where the engine is silent |
| S33 | cut bands | 1Q, 4Q; keep [0,1Q)+[2Q,3Q); slide; bypass; undo; a live stream | the map law seam-exact; separate gestures are separate undo steps, a live drag is one (ruling 2026-09-10) |
| S34 | edits on B never move A | 1Q, 4Q@2Q, 4Q@1Q; window, cut, bypass, clear B while playing, from three phases; undo all | A's and c1's phases against the epoch never change; the Q grid never moves; clearing re-bases nothing (rulings 2026-09-09/10) |
| S35 | nested maps | group with a 4Q member windowed [1Q,3Q) and a 2Q member; group window [0,1Q); move the inner; bypass the outer | members read the group's mapped clock folded again on their own map |
| S36 | seek over maps and groups | cut bands + a windowed clip + a windowed group; seek 5Q | the same phase renders the same samples after the seek |
| S37 | rich round trip | cut bands, a windowed clip, an anchored windowed group, a one-shot, a gated root song; save; load in a fresh engine | every fact (segments, windows, anchors, period source, song) and the render survive |
| S38 | multi-mic group take | 1Q, 4Q; a 3-mic 4Q kit at 2Q; window the kit; delete a mic; undo | one origin per performance; every mic reads the mapped clock; the rest hold their phase |

## 2. Open questions (expectations the owner must confirm)

Ruled 2026-09-09 (owner): (1) "at 5Q" = 5Q long; "edit to 1Q" = a loop
window ✓ as assumed. (3) A one-shot can never be the only content —
now REFUSED (S28). (4) A second arm under a live take is REFUSED (S27).
(5) Edits are refused while a take is live, wholesale (S26 — the
live-take gate, design_language.md §5). (7) The through-map scenario
exists (S29).

Still open:

1. **A radio (period-less song).** A root song whose successor graph
   has a chance branch has no period; the engine unrolls it to a
   256-visit horizon and today the island cycle is lcm(Q, that
   horizon length) — masterPos wraps only there. Alternatives: no wrap
   at all (the cursor runs on), or wrap on the loops beneath and let
   the song run over them. Which?
2. **Epoch re-base on growth** — S2 pins `epoch := epoch +
   floor((origin − epoch)/C_old)·C_old` (Q14b): when a take grows the
   cycle, the frame top moves to the top of the OLD cycle in which
   the take started, so the take shows where the performer watched
   it (e.g. armed at 2Q of the third 4Q bar → the new 8Q frame starts
   at 8Q and the take sits at its 2Q). Audio is identical either way;
   only the displayed frame differs. Confirm.
3. **Q15's stored origin** — RULED 2026-09-09: the framing was wrong
   ("if the window has the island repeating every 5Q, the entire
   universe is that 5Q"). The fold is gone; the origin is the capture
   boundary (S3 re-pinned, S32 pins the audible consequence). The same
   round found the field bug behind the owner's sequencer report —
   S30/S31 and the display contract above. The radio's cycle (item 1)
   is punted to a separate design pass.
4. **A one-shot stack with a sequence** — undefined (owner,
   2026-09-08); S25 uses a plain one-shot group only.

## 3. Adding a scenario

`Island is;` then verbs (`record`, `recordGroup`, `window`,
`driveToPhase`, the engine's own verbs), then facts (`Q()`, `epoch()`,
`cycle()`, `origin(id)`, `dur(id)`) and one `expectOutput(is, span,
fn, label)` whose `fn(t)` sums `loopVal` / `windowVal` / `val(id, k)`
over the clips that sound at `t` (call `is.o(id)` / `is.d(id)` for
cached facts inside `fn`, never the live getters). Keep expectations
analytic; if you cannot write `fn` from the docs, the scenario needs a
ruling first — add it to §2 instead.

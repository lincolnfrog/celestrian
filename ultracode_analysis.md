# Celestrian core audit (ultracode)

> Written 2026-09-03. Scope: the kernel (kernel.md §2, composition.md) and
> the core that carries it — period law, units, recording, the audio-thread
> contract, the edit algebra, persistence, the sequencer, the UI mirrors,
> the tests, structure, docs. Method: fifteen read-only auditors, one per
> dimension, produced 244 raw findings; a merge pass clustered them to 187;
> every cluster was then judged adversarially — a REFUTE lens that reopened
> the cited files and estimated the change, and (for 130 of the 187) a
> PRINCIPLE lens that checked the claim and the recommendation against
> I1–I16, Q1–Q21, S1–S22 and performance.md §1. 171 clusters survived,
> 16 were rejected (Appendix B). The planned second sweep of the kernel
> core and the completeness critic were cut for budget; they can run
> later against this file. Baseline: the C++ suite passes (383 sections,
> `build/CelestrianTests_artefacts/Debug/CelestrianTests`); the run prints
> seven `juce_String.cpp:327` assertion lines (D10-6). The working tree
> carries the uncommitted C2 per-step-fades work; it was audited as-is.
> Every path:line below was checked by a verifier on 2026-09-03; the five
> highest-stakes findings (D1-1, D8-1, D5-1, D5-2, D6-6) were re-read by
> the author as well.

Severity: **critical** — wrong audio, a hang or a crash on a reachable
path; **high** — a second law, a derived-but-stored fact that has already
drifted, or a real correctness hole; **medium** — structural debt with a
clear simplification; **low** — hygiene. Counts: 2 / 20 / 75 / 74.

---

## 0. Verdict

1. **The center of the kernel holds.** One monotonic clock that nothing on
   the audio thread mutates but the callback (audio_callback.cc); one
   stored origin per node, clips and stacks alike (Q18, `AudioNode::
   origin_samples`); one `TimeMap` type for every geometry (time_map.h);
   one seqlocked island triple read once per callback
   (`StackNode::readIslandFacts` → `renderContext`); a snapshot-only,
   cast-free, allocation-free audio thread; a `const` render with an
   enumerated mutable set; bounce == live render by construction
   (bounce.cc builds blocks with the callback's own `renderContext`).
   None of that needs to change.
2. **The equation is stated once on paper and eleven times in code, and
   the copies have diverged.** D1-1 is the proof: a one-shot GROUP whose
   shot does not divide the cycle plays its members one Q late on every
   other firing, because `childContext` folds the child clock on the map
   period (or not at all) while the clip law folds on the context cycle.
   D1-3 counts the restatements; D2-1 counts the period-law copies (four
   C++ + two wrappers + at least eight JS under three laws); D13-4 counts
   the definer predicate (~18). This is the disease kernel.md §1 named,
   returned in a new host: not six fields for one fact, but six functions
   for one law.
3. **Q18's deletion list did not land.** `Edit::CollapseGroup`,
   `collapseGroupNow`/`uncollapseGroupNow`, the Insert/Remove group twins,
   the duplicated arm-time collapse and `memberHeardIndex` all survive
   (D6-1), and the two lock-collapse laws already have different gates.
   composition.md §8 and design_language.md Q18 say they are gone.
4. **The island is not an object and the root is not an ordinary node.**
   Every `StackNode` carries the island's eight fields and a third
   establishment law plants them on nested stacks; I14 is held by a scrub
   after every edit (D14-1). The root's frame top is two facts — its
   origin (the render anchor) and the epoch (masterPos, seek, bounce, the
   ruler, the grid) — and nothing keeps them congruent (D15-1). The root
   is persisted by a second path that drops its own window, map, period
   source and origin (D7-3, D15-8).
5. **Four contract holes can hurt today.** An orphan cued step spins the
   audio thread forever (D8-1, critical). Un-Combine and `loadSession`
   retire nodes before the snapshot that references them is replaced
   (D5-1). The map and take-table seqlocks use memory orders that admit
   a torn read on ARM64 (D5-2). Moving a group into its own descendant
   hangs the message thread (D13-8). Each is an hours-sized fix.
6. **The recording lifecycle is honest but has grown flags.** A fifth
   unnamed state and the take KIND live outside `RecState` (D4-3); "a
   take is live" has two truths (D4-4); the callback keeps view state
   (D4-5); commit authors geometry on every take (D4-7); the commit
   event is hand-rolled twice (D4-8); `commitRecording` is check-then-
   store and reachable from both threads (D4-9).
7. **The edit algebra has the right shape** — one applier per kind, raw
   inverses, everything retired through the reclaimer — but three
   inverses are not inverses (D6-2, D6-5, D6-6), one seek path skips
   settlement (D6-4), and the rider channels are a second undo mechanism
   (D6-9).
8. **The JS side re-implements the kernel a third time.** The mock is a
   self-pinned ~3,500-line implementation of the composition laws whose
   only engine-derived pin is a gitignored capture that skips when absent
   (D9-1); the VM keeps fixture-only fallback laws in production code
   (D9-12).
9. **performance.md §1 is enforced by reading.** No allocation guard, no
   sanitizer build, no threaded test, no `add_test` (D10-5, D10-4,
   D5-10). The lock-free machinery this audit questions has no pin.
10. **The three biggest levers**, in order: state the equation and the
    period law once and delete the copies (Tier 2 below); make the island
    an object and the root ordinary (D14-1 → D15-1 → D7-3/D15-8); put the
    audio-thread contract under automation (D10-5, D5-10). Everything
    else in this report is either an hours-sized fix or follows from one
    of those three.

---

## 1. What is solid (keep)

The verifiers recorded these as strengths while refuting findings against
them. They are the things not to touch while doing the rest.

**Clock and origin.**
- `global_transport_pos` is advanced only by the callback
  (audio_callback.cc) and by nothing else on the audio thread; masterPos
  is derived on the message thread (transport.cc:132-140). I8 holds.
- `origin_samples` is the only stored timing fact for clips AND stacks;
  launch point, lane x and take mark are computed at read time
  (audio_node.h:379-382 `timing::launchPointFor(...)`). kernel.md §2's
  projection table is what the code does.
- Origin-gated adoption (`setOriginGated` / `adoptOriginGate`,
  audio_node.h:819-834) makes "new origins with the new epoch, or
  neither" true per block for every node; `shiftOriginsGated`
  (island_geometry.cc:309-316) is the one re-anchoring primitive used by
  the definer trim, continuity and seek alike.
- I10 holds on the render path: the leaf reads content only through the
  gated origin (clip_node.cc:544) and the stack anchors its map at its
  own origin (stack_node.cc:345-358). The epoch selects no content.

**The map.**
- ONE `TimeMap` (time_map.h): POD, segment-general, allocation-free,
  shared by clips and stacks, stored inline behind a seqlock
  (`storedMap`/`setMap`), with the tri-state none|active|bypassed that
  I9 requires.
- ONE seam-run driver used verbatim by control and render
  (`StackNode::forEachSeamRun`, stack_node.h:438-506), so both phases see
  the same child clock run for run.
- Recording is the equation run backwards: `timing::throughMapDest`
  (timing.h:178-185) is the fold, used by capture; composed active maps
  are refused for recording by one parent walk (take_service.cc:295-303).

**Units.**
- The rounding law is one function with an exact int128 implementation
  and a mathematical floor (qtime.h:221-226); `fromSamples` is exact by
  construction; `qcmp` cross-multiplies in int128; `lcm` saturates rather
  than wraps. QTime never appears on the audio thread. Capture and
  playback cannot round differently: the arm target, stop boundary,
  commit duration and through-map destinations are computed once as
  integer samples.
- The pure timing layer (qtime.h, time_map.h, timing.h) includes no JUCE
  header.

**Recording.**
- ONE explicit `RecState` whose parameters are written before the state
  flips (clip_node.h:30-52); the audio thread alone picks stop boundaries
  from its own write position; the origin is re-stored per block while
  Armed and commit computes nothing else.
- One capture-window law for all three arm paths and both content kinds
  (`capture_next_clock_ = context.input_clock + (target −
  compensated_pos)`, clip_node.cc:1219).
- Group arm publishes every member back-to-back after all reservations;
  group stop parks one generation published in one store
  (take_service.cc:349-356, 840-869).
- Every message-thread edit that moves island facts is refused under a
  live take (`movesIslandFacts`, edit_log.cc:965-978; map_edits.cc:34-41,
  372-380; seek transport.cc:35).

**Audio thread.**
- One structure load per callback (audio_callback.cc:118-121) and one
  context builder shared with bounce (engine_internal.h:25-58).
- The island-facts seqlock is correct on weak memory because its data
  fields are seq_cst (stack_node.h:159-188) — see D5-2 for the two that
  are not.
- Content-buffer discipline (D4) holds: render loads `content_` once,
  compaction runs only on Idle clips on the message thread, every pointer
  swap exchanges first and retires second.
- `RtLog` is a bounded, allocation-free ring with a try-lock; the MIDI
  plumbing is POD and lock-free end to end; the `Sequence` is an
  immutable object behind one atomic pointer with every derived table
  precomputed in `finalize()` and O(log n) audio-thread lookups.
- The control/render split is structural: `process` is non-virtual,
  render is const, the mutables are enumerated (audio_node.h:703-712) and
  pinned by render_purity_tests.cc.

**The edit log.**
- One applier per kind returning its exact inverse; inverses carry RAW
  old values (`inv.tmap = node->storedMap();  // the RAW old geometry`,
  edit_log.cc:426, 585); `retireEdit` routes every detached node, buffer,
  take and slot through the reclaimer.
- The non-undoable set is principled, small and mirrored exactly in the
  mock (mixer knobs, monitoring gestures, transport).
- Takes are undoable despite the audio-thread commit (`PendingTake` +
  `reconcileTakes` log a Q7 group performance as ONE entry).
- Deleted per composition.md §8 and confirmed absent: `epochViewStep`,
  `Edit::origins`, `internal_transport_`, `collapse_epoch`, the "CLIPS
  ONLY" gate in `setPeriodSource`, the nested-stack `context_loop`
  carve-out.

**Persistence.**
- One QTime writer for save and metadata (`AudioNode::qtimeVar`); nothing
  derived from the equation is persisted (no launchPoint, anchors, cycle
  projections, program, playhead, x/y); island (Q, epoch) live at ONE
  place in the bundle; additive-compat defaults are consistent
  (absent gain = unity, absent inputChannelR = mono, absent rootGain/
  rootPan = unity/center); session.json writes are crash-atomic
  (`replaceWithText` = TemporaryFile + rename); mid-take loads are
  refused; the fx chain array IS the save format (vst3.md §6).

**UI and mirrors.**
- view_model.js has no pixels (Q everywhere, one `playheadQ`); the patch
  layer has exactly one Q→% conversion (sv_util.js:8). View state is
  UI-local by construction (view_prefs.js). The dead-reckoner is pure and
  bounded (law 10). The verb list cannot drift (protocol_contract.test.mjs
  parses main_component.cc). Q18 display twins are read, never derived.
- The JS mirrors are golden-pinned bit-for-bit for every shared key
  (17 case groups in shared/timing_golden.json, 15/15 consumed by both
  sides).

**Tests.**
- The ramp-decoding method (every recorded sample encodes its own clock
  index) makes "which sample is heard" a direct assertion; the
  message-thread equation is pinned against the render
  (content_frame_tests.cc:321-374); bounce == live is a golden; block-
  split independence is pinned wherever an envelope exists; the mock
  fuzzer is seeded, shrinking, with an EMPTY suppression list; plugin
  hosting is tested against a real crashing plugin out of process.

---

## 2. The kernel

### 2.1 The equation and the node model

**D1-1 — critical — A one-shot STACK does not fold its child clock on the
context cycle.** composition.md §2: `h = (t − O − a0) mod C`, and a stack
hands its children `t_child = O + inner(t)`. The stack implements the
REST region on C (`oneShotFacts`/`inRest`, stack_node.cc:171-189) but the
child clock is folded on the MAP period when a map is active
(stack_node.cc:358 `child_context.master_pos = O + map.mapOffset(
context.master_pos − O − a0)`) and not folded at all when none is. The
clip folds on the cycle (clip_node.cc:581-583, :604). Worked: Q = 1000,
bass D = 4000 at O = 0, drums group O = 2000 with 3000-sample mics,
periodSource = context. At t = 6000 (second firing, h = 0) the unmapped
child clock is 6000 and a mic renders `content[(6000 − 2000) mod 3000]
= content[1000]` — one Q late on every odd bar. The G-2 pin uses shot =
Q/2 in cycle Q, which divides, so it cannot see this. Principle: I5,
composition.md §2. Recommendation: in `childContext`, when `one_shot ||
map.active()`, compute `h = posMod(t − O − a0, one_shot ? cycle : P)` and
set `master_pos = O + (map.active() ? map.mapOffset(h) : h)`; give
`heard::nodeInner` the same fold (it needs a message-thread twin of the
context-cycle law) so content_frame_tests still pins render == solver;
add G-2b: a 3Q group over a 4Q bass, mapped and unmapped, `content[0]` at
every firing. Land this before D1-3 so the helper encodes the corrected
law. Effort: day. Risk: low. Benefit: high.

**D1-3 (+D1-13) — high — The render equation is hand-restated eleven
times; the clip's audio and MIDI loops are two copies of the run
splitter.** clip_node.cc:604, :684, :898, :927; stack_node.cc:186-187,
:358, :536-539; stack_node.h:381-383, :465-467; heard_index.h:51;
bounce.cc:97-101; island_geometry.cc:342-345; view_model.js:1766-1772 —
with different fold choices (cyc vs dur vs map period vs cycle). D1-1 is
exactly the drift such copies produce. Recommendation: after D1-1, one
`timing::innerAt(t, O, map, fold, shot) → {h, inner, run, rest}` in
timing.h (JUCE-free, golden-pinned, JS twin in time_map.js), adopted by
clip render, `renderMidi`, both playhead writes, `inRest`, `innerOf`,
`forEachSeamRun`, `childContext` and `heard::nodeInner`; then one
`forEachContentRun(context, map, fold, dur, cell_len, body)` that both
clip loops call, with the comp-cell length as a seam input. A stack and
a clip cannot then fold differently by construction. Effort: days.
Risk: medium. Benefit: high.

**D1-2 — high — The message-thread equation is depth-1.** `nodeInner`
(heard_index.h:51) applies only the node's OWN map to whatever `t` it is
given, and both solvers pass the raw transport clock for ANY node
(island_geometry.cc:203, :228). A clip inside a windowed group whose own
window is edited while playing gets a continuity origin for a sample that
is not the one sounding. The definer paths are safe only because
`hasActiveGeometryOutside` forbids ancestor maps; no test exercises depth
≥ 2 or an ancestor map. Recommendation: (1) now, cheap — extract the
ancestor walk of take_service.cc:288-303 into `activeMapsAbove(node)` and
have `attachMapEditRiders` skip the continuity rider (origin fixed) when
it returns > 0, with the same log recording already uses; (2) with D1-3
— `heard::receivedClockAt(node, t)` = the root→node walk applying, per
stack ancestor, exactly what `childContext` does; `nodeInner(node, t) :=
ownInner(node, receivedClockAt(node, t))`; delete `memberHeardIndex`;
re-pin content_frame_tests at depth 3 with two active maps and a cued
step. Effort: days. Risk: medium. Benefit: high.

**D1-7 — medium — The Q5 exclusion is restated at six C++ and seven JS
fold sites**, and the two implementations of the same virtual already
disagree: `AudioNode::getEffectivePeriod` (audio_node.h:650-654) returns
a one-shot clip's own pass length; `StackNode::getEffectivePeriod`
returns 0 for a one-shot stack. Recommendation: two accessors on
`AudioNode` — `intrinsicContribution()` and `periodContribution()`
(0 when `period_from_context_`), the folds iterate those, the own
accessors stay one-shot-agnostic; move the check in `snapEffectivePeriod`
to the function's entry. Folds into D2-1. Effort: day.

**D1-11 (+D14-9) — medium — Per-node playhead telemetry is a stored
projection with two meanings.** Clips publish phase over the one-shot
cycle (clip_node.cc:680-685), stacks over the map period or 0
(stack_node.cc:534-542); the UI reads it only as a WINDOW phase
(view_model.js:1625), so a windowed one-shot's amber cursor sweeps at the
wrong rate. It is a second engine-sampled clock mixed into the frame (I8)
and one of the two remaining mutables in render. Recommendation: interim,
both node types publish `h/fold` from `innerAt`; endpoint, delete
`playhead_pos`, the `"playhead"` key and `winCursor._phase`, and derive
`windowPhase` in the VM from `playheadQ`, the node's origin and its
composed received clock (D1-2's JS twin). Effort: days.

**D2-9 — low — The one-shot shot length is stated five times and
bounce's copy drops the map leg**, so a windowed one-shot bounces its
whole buffer (bounce.cc:92-96) while the render fires one window
(one_shot_tests.cc:135-152). Fix now: hoist `activeTimeMap()` above the
one-shot branch in bounce.cc, `span = map.active() ? map.period() :
intrinsic`, one bounce_tests case; then `timing::shotLength(map,
intrinsic)` used at clip_node.cc:565-577/:891, stack_node.cc:174 and
bounce.cc. See D2-5 for the sequence leg (needs a ruling).

**D3-2 (+D11-12) — medium — Hand-rolled `((x % m) + m) % m` folds survive
at seven C++ and ten JS sites** (clip_node.cc:604-605, 684-685, 898-899,
927-928, 1169; island_geometry.cc:261; sequence.h:306-310; time_map.js,
timeline_model.js, view_model.js, playhead_clock.js, seq_grid.js,
mock/sequence.js). Route all through `timing::posMod` / math_utils
`posMod` after D3-1. Hours.

**D3-13 — low — Two semantics for a degenerate modulus**
(`timing::posMod` returns the input, `heard::posMod` returns 0). Every
`heard::posMod` caller already guards `period > 0`; delete the wrapper.

**D13-9 — medium — `anchored = isClip || isAnchored()` is restated four
times** (heard_index.h:51-52, island_geometry.cc:199-200, :221-222,
bounce.cc:99-100) because `ClipNode` never sets its anchor flag. Make a
leaf anchored by construction and hoist `frameOrigin` onto `AudioNode`.
Day.

**D1-10 — low — Render's mutable inventory is clean except one
consume-once request** (`midi_sound_off_pending_.exchange` inside render,
clip_node.cc:739). Move the exchange to `control` into a plain block flag.
Hours.

### 2.2 The period and cycle law

**D2-1 (+D1-8, D2-2, D2-11, D2-13, D8-7, D9-4, D9-5, D10-14, D11-10,
D15-5) — high — The effective-period chain is stated four times in C++
plus two cycle wrappers and at least eight times in JS under three laws,
and the copies already disagree.** C++: `AudioNode::getEffectivePeriod`
(audio_node.h:649), `StackNode::effectivePeriodOf` (stack_node.cc:148),
`snapEffectivePeriod` (graph_snapshot.h:111), `childContext`'s inline
restatement before its fold (stack_node.cc:379-394 — a second child walk
per block), `calculateEffectiveCycleLength` (transport.cc:224) and
`snapEffectiveCycle` (graph_snapshot.h:135); the sequence rung is
re-tested at six engine sites under a "keep in lockstep" comment.
`effectivePeriodOf(node)` returns 0 when the node itself is a one-shot;
`snapEffectivePeriod` has no self check; bounce.cc:91-96 papers over the
difference. JS: timeline_model.js, view_model.js and the mock each state
a different law and mis-name a fourth quantity "intrinsic". composition.md
§3 says these "should become one"; tasks.md A2 counts "one fold + the
snapshot twin". Principle: I12, composition.md §3. Recommendation: ONE
law, two providers — a header template `periodFold<Children>(node,
children, skip) → {own, contribution}` with own = map ▸ activeSequenceLen
▸ (clip: D | stack: LCM of children's contribution) and contribution =
(oneShot || skip) ? 0 : own; instantiate over the ownership vector
(message thread) and over snapshot spans (audio thread); delete
`AudioNode::getEffectivePeriod`, `childContext`'s inline restatement and
`calculateEffectiveCycleLength` (:= `snapEffectiveCycle` over the current
snapshot); make `oneShotFacts` and bounce read `own(target)`; ONE JS
`effectivePeriod`/`intrinsicDuration` in timeline_model.js consumed by
the VM and the mock; golden-pin the chain with tree fixtures (D2-3).
Needs the D2-5 ruling for the one-shot-plus-sequence shape. Effort:
week+. Risk: medium. Benefit: high.

**D2-4 — medium — `context_loop` is behavior-identical to
`context_cycle` in every reachable state under I13** except one corner
(a plain group under a free-length sequenced ancestor: direct children
arm on the song-top grid, grandchildren do not — non-fractal). Delete
`ProcessContext::context_loop`, the `longest_committed` walk
(stack_node.cc:468-494) and call `armTarget(rel, Q, max(Q,
context_cycle))` at clip_node.cc:1132; fold the row into composition.md
§3. Rule the corner first (recommend: the grid restarts at the song top
at every depth, I5). Hours.

**D2-5 — medium — needs ruling — A one-shot STACK's shot length skips
the sequence layer; the UI includes it.** `shot = map.period() ▸
snapIntrinsicDuration` (stack_node.cc:174-176) vs the VM's `displayPeriodQ`
(map ▸ sequence ▸ D). A one-shot group with a two-step 4Q + 4Q sequence
over 4Q children in a 16Q scope never sounds step 2. Question: does a
one-shot stack with an active sequence fire (a) its whole song, (b) its
intrinsic LCM, or (c) is the combination refused? Recommend (a): shot =
the node's OWN effective period (map ▸ sequence ▸ D), i.e. the `own`
half of D2-1's template. Day.

**D2-6 (+D4-15) — medium — needs ruling — Island cycle snapshots are
taken once per take-SET** (`if (active_takes_.fetch_add(1) == 0)`,
stack_node.cc:213), so a second take armed under a live one inherits the
first arm's `heard_cycle_at_arm_`/`lcm_before_take_`; if the first commit
lands before the second capture starts, the second take's Q15 fold and
persisted `contextCycle` use a frame that no longer exists (an I1 phase
error for the windowed-group + root-clip polyrhythmic case). Overlapping
arms are refused nowhere. Question: may a new take be armed while another
is capturing? Recommend NO for 1.0 (refuse in `startRecordingInNode` and
`newTake`, mirror in the mock, one test) — the snapshots are then exact
by construction. If YES, make both cycles per-take facts read at the
take's own capture start from the block's snapshot. Day.

**D2-8 — medium — Bounce has no span cap**: `audio(2, (int)(span +
tail_cap))` (bounce.cc:127) with a saturated or merely large effective
period is UB or `bad_alloc` on the message thread; the arm path caps the
same quantity (take_service.cc:332). Refuse `span > ClipNode::
kMaxTakeSamples` after the `span <= 0` refusal, before
`removeAudioCallback`; mirror in mock/bounce.js; one test. Hours.

**D2-10 — low** — import computes `contextCycle` by a second path
(import.cc:250) instead of the arm snapshot `beginCapture` reads; one
`takeHeardFrame(island)` helper. **D2-14 — low** — divisor periods (Q/k)
are first-class in the engine but the JS `commensuratePeriod` rounds them
up to Q (timeline_model.js:149-154); export one `coherentWithQ(p, q)`.
**D2-15 — low** — the JS `lcm` does not saturate; clamp at
`Number.MAX_SAFE_INTEGER` and pin the C++ downstream of a saturated
cycle with D2-8's test. **D2-7 — low** — Q-coherence has two undocumented
bypasses (sequence step lengths — ruled by S10, name it in I13; session
load — add the one-line scrub after `setQuantum` in `loadSession`).

### 2.3 Units and the conversion boundary

**D3-1 — high — `posMod`'s `((a % m) + m) % m` overflows once `lcm` has
saturated.** qtime.h:152-154; `lcm` deliberately saturates at INT64_MAX
(qtime.h:143-145) and the saturated value is then a modulus in the clip
render loop (one-shot `cyc = context_cycle`), `inRest`, the published
masterPos and `seekTransport`: `(a % m) + m` exceeds INT64_MAX for any
positive residue — signed overflow, UB, on the audio thread.
`Sequence::fold` (sequence.h:306-310) is the overflow-safe form, so the
codebase has two fold laws and the canonical one is the fragile one.
Fix: `if (m <= 0) return a; const int64_t r = a % m; return r < 0 ? r +
m : r;` (r ∈ (−m, 0] when negative, so `r + m` never overflows); same in
math_utils.js; pin `posMod(5, INT64_MAX) == 5` etc. in qtime_tests.cc;
then D3-2. Hours. Reachability today requires several coprime unsnapped
takes (the comment at qtime.h:137-139 says this happens), so it is rare,
but the fold is THE fold and must be total.

**D3-8 — low** — `snapCommittedDuration` keeps the last floating-point
timing decision, `(int64_t)(0.15 * (double)Q)` (timing.h:28, :228; JS
:73, :351). Replace with a rational (`min_diff * 20 < Q * 3`, or `min_diff
< 3 * Q / 20` for bit-identity — decide once) and add one golden
`snap_case` ON the boundary for an odd Q. **D3-9 — low** —
`nearestWholeQ` (import.cc:111-114) rounds a QTime through `llround`
(half away from zero), a second tie rule to `toSamples`; use
`toSamples(qtime(n, d), 1)`. **D3-5 (+D15-10) — low** — the Q-coherence
predicate lives twice in island_geometry.cc, in map_edits.cc, three times
in the mock; one `timing::periodCoherent(p, q)` + JS twin + a
`coherence_cases` golden. **D3-7 (+D8-14, D12-19) — low** — the 10 ms
anti-pop constant is written twice (sequence.h:431 truncated int64,
audio_node.h:687 double) and 44100.0 seven times; one `kAntiPopSeconds`
/ `antiPopSamples(sr)` in timing.h. **D3-11 — low — needs ruling** — the
pre-Q "one second" cycle fallback is derived from the sample rate at three
sites (engine_internal.h:56, audio_callback.cc:177-179, transport.cc:
225-229); derive it once, and record in composition.md §3 what the island
cycle IS before Q exists. **D3-12 — low** — `nextStopBoundary` divides by
`quantum` with no guard (timing.h:110-111) while every sibling guards;
`if (quantum <= 0) return recorded_length;` + one golden vector.
**D3-14 — low** — qtime.js's stated 2^53 bound assumes whole-Q
numerators; the true bound is `|samples| · Q_samples < 2^52`; correct the
comment and throw on an unsafe intermediate. **D3-6 — medium** — golden
coverage gaps: `posMod`, `foldPeriod`, `qcmp`/`qeq`, `subdivisionSamples`,
`periodQ`, lcm saturation and negative-origin `launchPointFor` have no
shared vector; timing_golden_tests.cc:52-54 exercises `lcm` directly, not
`foldPeriod`. Add the vectors. Hours.

### 2.4 The recording lifecycle and island facts

**D4-1 — high — Move/Combine of an armed or capturing clip is
unguarded.** Remove refuses (`if (node->isArmedOrRecording()) return {};`
edit_log.cc:259); Move (:326-340), Combine (:337-357) and Explode
(:358-386) do not. The detach/insert pair cycles the root take counter
through zero (re-snapshotting the arm cycles) and opens a window in which
an audio-thread commit drives it to −1 — `hasActiveTake()` then reports
false for the rest of the session and every guard gated on it reopens;
Combine registers the take on the detached stack's own counter, which
nothing scrubs. Refuse all three like Remove; decide whether a refused
structural edit drops the entry or keeps it (the `movesIslandFacts`
path); add the D4-16 tests. Hours. Benefit: high.

**D4-9 — medium — `commitRecording` is check-then-store and reachable
from both threads.** clip_node.cc:1399-1402 tests `recState() != Idle`
then stores; the pre-Q first-clip stop commits on the MESSAGE thread
(:1383-1388) while the audio thread can commit the same take at the
reservation wall (:196-203): both pass the check, `takeCommitted` fires
twice, the counter goes negative. The pre-Q GROUP stop re-reads Q inside
`commitRecording` (:1412), so members after the first commit snap against
the Q the first member just established. Make the pre-Q stop a request
like every other stop (the audio thread commits at its next block top),
delete the message-thread commit path, flip the state with
`compare_exchange`, pass the stop-time Q into the commit. Day.

**D4-3 (+D14-11) — medium — A fifth unnamed state (Settling) and the take
KIND live outside `RecState`.** `retake_period_` is both the "is a
retake" boolean and a copy of `duration_samples` copied again into
`capture_cap_`; five audio-thread decisions key on `retake_period_ > 0`
or `map_commit_cycle_ > 0`; `isAwaitingStop` reconstructs "stop
requested" from three fields; `retakeSettled` from two flags. Not
drifting today (duration edits are refused under a live take), but it
contradicts the header's own "ONE explicit state". `enum class TakeKind
{ FRESH, THROUGH_MAP, NEW_TAKE }` fixed at arm, explicit StopRequested
and Settling states (or one `Outcome` atomic), one `capture_cap_`. Days.

**D4-4 — medium — Two truths for "a take is live"**: the root counter
(`active_takes_`, fed by six lifecycle hooks) and the recursive
`isArmedOrRecording` scan; seek, bounce and import check both, ~25 guards
check only the counter, ~16 only the scan. Collapsing to the scan is
sound only if `rec_state_ → Idle` moves after `island->takeCommitted`
(today the clip reads Idle before the re-base lands). One predicate.
Day.

**D4-5 (+D14-5) — medium — The audio callback maintains recording VIEW
state** (the frozen cursor base: `was_any_node_recording_`, `view_base_`,
`view_anchor_t_`, `view_recording_`, audio_callback.cc:158-186) by
edge-detecting the take counter every block, recomputing the heard cycle
through a second implementation, and mirroring `hasActiveTake` only while
playing (arm → pause → cancel leaves the frozen view published). Store
`t_arm` on the `PendingTake` at the message-thread arm and derive the
view in `getGraphState`; the audio thread then touches no view state
(I6). Day.

**D4-7 — medium — Commit authors geometry on every take.** Every
committed clip is given a stored single-segment `[0, D)` map
(clip_node.cc:1446, :1461, :1464) although `map_n_ == 0` is already the
render's own full-span fallback (:508-511); `windowActive` is therefore
true for every committed clip and a "full-span is furniture" carve-out
exists in five places. Commit stores (origin, duration) only; keep the
unsnapped sub-region write; model it as the island's provisional definer
window written once by the message-thread settle for clip and group
alike — which deletes `liftGroupWindow` and the carve-outs. Days.

**D4-8 — medium — The commit event is hand-rolled twice.** The
message-thread half (Untake inverse with (Q, epoch)-before, anchor
settle, undo push, pre-Q scrub, auto-gate) exists in `reconcileTakes`
(take_service.cc:697-780) and inline in `importAudio` (import.cc:255-274),
already different (import has no S19 auto-gate). One
`settleCommittedTake(...)` for recorded and imported takes. Day.

**D4-6 — medium — MIDI compensation prefers the driver report over the
measured round trip** (audio_callback.cc:139-146) while audio uses the
calibrated value first — I7 inverted for MIDI; every recorded note shifts
by the driver report's error. Step 1: calibrated minus the one assumed
leg, driver report only as the uncalibrated fallback. Step 2: a MIDI
calibration. Days.

**D14-15 — medium — needs ruling — Capture and arm evaluation run while
the transport is paused.** `root_node->process(...)` and `input_clock_ +=
num_samples` run unconditionally (audio_callback.cc:142-148); only the
clock is gated (:156). A take paused mid-capture keeps ingesting from the
ring, and every sample after resume lands (pause length) later in content
than where the performer heard it (I1). Reachable from the transport
button and the "user insists" second Space. Question: while a take is
armed or live, is pause refused (engine law, like seek), with the UI's
stop-at-boundary-then-pause as the gesture? Recommend YES (Option A):
`togglePlayback` returns false under `hasActiveTake()`; the play button
routes through the space bar's deferred-pause path. Hours.

**D14-3 — medium** — `take_context_cycle_` is overwritten at a retake arm
and not restored on cancel (clip_node.cc:1199-1202, cancel :131-145);
capture it only for a FIRST take of the slot. Hours. **D14-4 — medium** —
inactive-take records carry dead copies of the slot's origin/duration/
context_cycle that go stale after a seek (clip_node.h:422-431,
transport.cc:108 maintains them); split `TakeState` into `TakeContent`
and `SlotFacts`. Day. **D4-11 (+D14-2, D14-8) — medium** —
`commit_master_pos` and `awaiting_start_at` are write-only telemetry read
only by tests; `live_duration_samples` mirrors `write_position`; both
duration fields are leaf facts hoisted onto `AudioNode` so every stack
publishes `duration = 0`. Delete the three; move `duration_samples` to
`ClipNode`. Day. **D4-14 — low** — three stop channels (direct flag,
parked generation, immediate pre-Q commit) where the generation alone
would do. **D4-10 — low** — two readings of the epoch (`AudioEngine::
islandEpoch()` raw vs `StackNode::getIslandEpoch()` gated on Q > 0) and
four accessors for one seqlocked triple; one accessor. **D4-12 — low** —
`adoptOriginGate` is inlined in `ClipNode::control` and the arm "reached"
predicate is written three times with a magic 512. **D4-13 — low** —
performance.md §3 says the capture window reaches back into the ring; the
window start is ≥ `input_clock` on every path (the pickup is a wait, not
a reach-back); true the doc and either size the ring to a few blocks + C
or say why 2 s. **D5-15 — medium — needs ruling** — the island seqlock's
single-writer rule rests on eleven scattered `hasActiveTake` guards and
the Remove case's provisional-Q revert (edit_log.cc:280-284) is not one of
them: deleting the sole committed clip while another take is live runs
`setIslandFacts(0, 0, gen)` under the recorder, whose commit then writes
(Q, epoch) from the audio thread. Question: may the Q-definer be deleted
while another take is live? Recommend refuse (the Remove applier's Nop
idiom, mirrored in the mock) plus a `jassert(!hasActiveTake())` at the
message-thread writer. Day. **D6-13 — low** — the Q-establishment scrub
clears pre-Q geometry AFTER the take's inverse is pushed, so undo of the
establishing take restores Q := 0 but not the geometry; scrub before
`pushUndo` and push `WindowRider`s onto the inverse.

### 2.5 The audio-thread contract and the memory model

**D5-1 — high — Detached nodes are retired BEFORE the snapshot that
references them is republished.** Un-Combine retires the emptied stack
inside `applyEditImpl` (edit_log.cc:392) and `applyEdit` publishes only
at :78; `loadSession` retires every old child (audio_engine.cc:129-131)
and publishes at :163 with up to three reaping `retire()` calls between.
The reaper frees anything two callbacks past its stamp (audio_engine.cc:
75-77); the stamp is taken BEFORE the object becomes unreachable, so if
two callbacks elapse inside the window the reap frees a node the
published snapshot — or a callback that just loaded it — still points
at. The comment at audio_engine.cc:53-56 claims the opposite. Fix by
construction: every detached graph node goes through `retireNode(...)`
which PARKS it; `publishGraph` moves parked nodes into the graveyard
stamped with the post-exchange `callback_count_`, then retires the old
snapshot as today. Belt-and-braces: in `publishGraph`, after the
exchange, `item.epoch = max(item.epoch, now)` for every pending item.
Pin with a reclaimer-ordering test (D5-10). Hours. Benefit: high.

**D5-2 (+D12-9) — high — Three hand-rolled seqlocks with memory orders
that do not exclude torn reads on ARM64.** Map writer: `map_seq_.
fetch_add(1, release)` followed by RELAXED stores (audio_node.h:534-540);
reader: relaxed loads then `s2 = map_seq_.load(acquire)` (:521-526). A
release RMW orders only PRIOR operations; an acquire load orders only
SUBSEQUENT ones. So the data stores may be reordered ahead of the odd
increment and the data loads after the even check: a reader can accept
a torn `TimeMap` (one block of wrong offsets) or a torn take table
(clip_node.cc:1657-1700, same shape). x86 TSO hides both; this machine
is ARM64. The island triple is correct only because its fields default
to seq_cst (stack_node.h:159-188). Three copies of one protocol with
three after-bound policies. Fix: one `SeqLocked<T>` helper (src/
seq_locked.h, JUCE-free): write = `seq.fetch_add(1, relaxed);
atomic_thread_fence(release); f(); seq.fetch_add(1, release)`; read =
`s1 = seq.load(acquire); f(); atomic_thread_fence(acquire); s2 =
seq.load(relaxed)`; per-field atomics stay (relaxed inside the lambda is
then correct); one after-bound policy ("take what you have, clamped");
replace the three loops. Combine with D5-4. Hours.

**D12-10 (+D5-7) — high — Four "maximum block" constants with two values
(4096 / 8192), and every node keeps a grow-if-bigger path that allocates
in render.** stack_node.cc:25-31, vst3_slot.h:44-47, fx_chain.cc:139-142
say 8192; clip_node.cc:43-44 says 4096; the growth guards run
`std::vector::resize` / `AudioBuffer::setSize` inside the const render
phase (stack_node.cc:519-526, 579-584; clip_node.cc:554-556, 571-573,
709-710, 975-976). A device block above 4096 (some ASIO and CoreAudio
devices offer 8192) allocates on the audio thread on the first block.
One `kMaxBlockSamples = 8192` / `kMaxOutputChannels` pair in a JUCE-free
header; size every scratch from it; clamp `num_output_channels` at the
one callback entry; delete the growth paths. Day.

**D5-4 (+D12-20) — medium — A stack's seqlocked map is read up to six
times per block, separately by control and render** (stack_node.h:441;
stack_node.cc:182, :344, :486, :534, :605). A `setMap` landing between two
reads inside ONE callback lets the seam split run for map A while
children are clocked with map B. The island facts were made a
per-callback triple for exactly this reason; the map — the kernel's ONLY
time transform — has no per-block adoption point. Add `map_rt_` adopted
at the block top beside `adoptOriginGate` (gated by the same island
generation, so a Q13 re-trim lands origins, epoch AND windows as one
fact); every consumer reads `map_rt_`. Day.

**D5-5 — medium — Multi-field clip facts changed together are stored as
separate atomics and read piecemeal.** `collapseToWindow` stores
`content_base_`, `origin_samples`, `duration_samples` and the map in
sequence (clip_node.h:312-316); render can pair the old gated origin with
the new base for one block — a click on exactly the gesture that should
be inaudible; `spliceToMap` has six stores plus a pointer swap. Generalize
the existing gate: `adoptFrame(context)` copies origin, duration, base,
map and the content pointer into audio-thread twins at the block top
under the island generation; every multi-field writer takes a gate.
Days.

**D5-9 — low** — buffers reachable through published `content_`/`midi_`
pointers are freed or reallocated inline (`reserveTakeStorage`,
`prepareRetake`), safe only by an unpinned `is_playing` gate argument that
lives in comments and contradicts performance.md's lifetime rule; return
the displaced storage and retire it. Day. **D5-3 — low** — the graveyard
is reaped only inside `retire()`: frozen while the device is stopped,
last items linger; extract `reapGraveyard()` and call it from the poll.
**D5-8 — low** — the callback re-reads island facts raw and the play flag
twice after holding the consistent context (audio_callback.cc:156, :164,
:177-180). **D5-11 — low** — gate resolution copies a `juce::String` per
child per seam run (stack_node.cc:614); `const juce::String& getUuid()`.
**D5-14 — low** — `RtLog`'s magic static can be first-touched on the
audio thread; touch it in the `AudioEngine` constructor. **D14-13 —
low** — `preferred_input_channel(_right)` are plain ints crossing
threads; make them atomic. **D8-8 — low** — the `Sequence` pointer is
loaded five-plus times per block per stack; adopt once per block like
the map. **D5-13 — low** — performance.md:101 "Known residuals: none"
and three code comments state guarantees the code does not provide;
replace with an honest residuals list until D5-1/D5-2/D12-10 land.

### 2.6 The edit algebra

**D6-1 (+D11-1, D12-8, D13-3, D15-6) — high — Q18's lock-collapse
deletions did not land.** `Edit::CollapseGroup` (edit.h:63),
`GroupCollapseFacts` / `collapseGroupNow` / `uncollapseGroupNow`
(edit_log.cc:159-205), the Insert re-collapse twin (:249-252), the Remove
re-open twin (:308-322), the applier (:543-565), two verbatim arm-time
blocks (take_service.cc:205-226, :447-465) and `heard::memberHeardIndex`
(heard_index.h:68-75, one test caller) all exist; composition.md §8 and
design_language.md:269-270 say they were deleted. The two laws already
diverge: the clip gate collapses a cell-mapped definer by splicing while
the group gate refuses any `hasSegmentMap()` stack; `liftAncestorsOf`
(edit_log.cc:47-51) stores origins ungated while the LoopPoints/Segments
path gates them (D12-7). design_language.md Q13-for-groups (:548-563)
still says member origins STAY. Recommendation: composition.md §5's one
row as ONE `Edit::Kind::Collapse` over any definer node N: leaves under N
get `base += s; D := len; window full` (split the origin write OUT of
`ClipNode::collapseToWindow`), exactly one recursive `shiftOrigins(N, s)`
plus the ancestor lift already in `applySetsOrigin`, N's window consumed;
the inverse carries raw {shift, old_duration, window}; Insert re-collapse
and Remove re-open become one branch each over "the definer node"; one
`collapseDefinerAtArm(exclude)` in take_service; delete the twins and
`memberHeardIndex` (content_frame_tests.cc:370 becomes
`nodeInner(*member, O_stack + nodeInner(*stack, t, epoch))`). Rewrite
Q13-for-groups' lock-collapse paragraph to a pointer at composition.md
§5. Days. Risk: medium. Benefit: high.

**D6-2 — high — A seek does not shift the splice-collapse inverse's
absolute origin.** edit_log.cc:491 stores the pre-splice origin in `iq`;
`shiftHistoryAbsolutes` (transport.cc:100-110) shifts `iepoch`, `iorg`,
riders, takes and subtrees but never `iq` — contrary to its own comment.
Sole definer with a cell map → second arm (splice) → seek → undo take →
undo collapse restores the pre-seek ABSOLUTE origin. Store it in `iorg`
with `setsOrigin` (already shifted; `applySetsOrigin` is never called for
`CollapseTake`); `iq` must never again hold an absolute. One test. Hours.

**D6-6 — high — Combine/Explode is not an inverse pair.** Explode retires
the emptied stack (edit_log.cc:392) and its inverse Combine builds a
brand-new `StackNode` (:354): redo changes the group's uuid, drops its
name/sequence/fx/mute/window, and every later redo entry addressed to the
old uuid Nops and is silently dropped. edit.h:246-248 says `node`/`node2`
exist for this restore; they are never populated. Fix: `inv.node =
stackParent->removeChild(stackIdx)` (the Remove discipline) and Combine
reuses `e.node` when present. Pin with combine → rename → setSequence →
undo×3 → redo×3. Hours.

**D6-4 — medium** — `seekTransport` does not call `reconcileTakes()`
(transport.cc:28-36) while record/undo/redo do; a take committed on the
audio thread but not yet polled is invisible to `shiftHistoryAbsolutes`,
so its later Untake entry carries a pre-seek `epoch_before`. One line.
Hours. **D6-5 — medium** — `settleAnchors` re-expresses or clears a
stack's pre-anchor map (island_geometry.cc:381-403) but the `AnchorRider`
carries only (anchored, origin); undo of the first take under a windowed
empty group leaves the rewritten map. Add `setsMap/tmap` to the rider
(the `WindowRider` shape). Hours. **D6-8 (+D12-13, D3-10) — medium** —
`Edit` is an untyped payload bag: `iq/iepoch`, `b1`, `d1/d2`, `index`,
`uuid2` each mean three or more things; int64 sample facts travel as
doubles; every total consumer (`shiftHistoryAbsolutes`,
`movesIslandFacts`, `retireEdit`) is a hand-maintained per-kind table —
D6-2 is the concrete cost. Incremental typing: `d1/d2` → int64; collapse
inverses get their own `shift/old_duration`; exactly ONE absolute-origin
slot; then a `forEachAbsolute(Edit&, f)` so the seek walk is total. Days.
**D6-9 — medium — needs ruling** — the eight rider channels are a second
undo mechanism with five private appliers and a log-top mutation
(take_service.cc:831-834). Question: adopt `Edit::Kind::Compound` (ordered
parts, reversed inverses, ONE island generation per compound, all-or-
nothing) and retire the riders, or keep riders? Land D6-5, D6-6 and
D6-13 first either way. Week+. **D6-12 — low** — `combineNodes` and both
import paths push to the log without `reconcileTakes()` (log order
inverts within one poll). **D6-14 — low** — coalescing keys on
`Kind::Segments` only; a live drag whose intermediate map is a single
window emits `LoopPoints` entries; carry a gesture id or treat the two
kinds as one family. **D12-7 — medium** — the ancestor origin lift exists
twice (ungated `liftAncestorsOf`, edit_log.cc:47-51; gated loop in
`applySetsOrigin`, island_geometry.cc:331-333); one `liftAncestorsGated(
node, delta, gate)`. Hours. **D6-11 (+D9-7) — medium — needs ruling** —
26 edit kinds, 74 bridge verbs, undoability hand-listed in three places,
a third undo implementation in the mock. Cheap step now: `undoable:` as
DATA in protocol.js, derive the mock's set from it, extend the contract
test. Question for later: one `applyEdit(editJson)` wire verb? **D13-8 —
high** — Move has no ancestor guard: `insertChildAt` sets the parent
pointer before `maybeEstablishQuantumFrom` calls `rootNode()`, so moving
a group with committed content into its own descendant is an infinite
parent walk (app hang); an empty one becomes a self-owning subtree. The
drop handler excludes only the target itself. Refuse a destination inside
the moved subtree at the applier and in the mock. Hours. Benefit: high.

### 2.7 State redundancy, the island, and the root

**D14-1 (+D4-2, D6-10, D7-8, D13-5) — high — Island facts are stored on
EVERY `StackNode` and established by a third law.** Eight island-only
fields (stack_node.h:514-538) exist on every stack; `getEffectiveQuantum`
/ `getIslandEpoch` walk parents until a nonzero Q, so a stale nested value
shadows the root's; I14 is held by `scrubNestedIslandFacts` after every
structural edit (island_geometry.cc:489-515, edit_log.cc:71-77) and by
`setQuantum(0, 0)` on load (session_io.cc:349-352). Q and the epoch are
written by three laws: the clip's arm/commit on the audio thread, import,
and any `addChild`/`insertChildAt` whose child carries content
(`maybeEstablishQuantumFrom`, stack_node.cc:203-208, :284, :291) — which
fires on every DETACHED subtree (Combine builds its stack detached;
undo-held nodes). Stage 1 (day, no ruling): delete
`maybeEstablishQuantumFrom` and its two calls, delete
`scrubNestedIslandFacts` and its call, delete the load-time scrub, keep
the NESTED FACTS test as the pin. Stage 2 (Tier D "islands as objects"):
move `quantum_samples_`, `epoch_samples_`, `island_seq_`,
`island_generation_`, `stop_generation_`, `active_takes_`,
`lcm_before_take_`, `heard_cycle_at_arm_` into an `Island` record owned
by the engine (or by the root only, by type), passed down in
`ProcessContext` as today. Days. Benefit: high.

**D15-1 (+D8-3, D13-1, D13-2, D8-2, D8-18) — high — The root has two
frame tops.** After Q18 a stack's sequence, cue and audition are anchored
at the stack's own origin (`frameOrigin`, stack_node.h:373-383;
stack_node.cc:598-606), but every projection and verb that names a song
position — masterPos, the grid's playing column, seqDims/fades/cue bands
(tiled from lane base 0), seek, the root bounce span, and the engine's
own S21 step lookup (root epoch on the raw clock, even for a nested
sequenced ancestor and even under a map) — reads `(t − epoch)`. The two
coincide only at the first commit; a cycle-growth re-base or a
non-definer's continuity rider moves one and not the other, and nested
groups never had the congruence. Recommendation: make the island root's
frame top ONE fact — every epoch writer (`setIslandFacts`, `seekEpochTo`,
`rebaseEpochOnGrowth`, the cycle-top rule, the two-anchor rider,
`setIslandQuantum`) also shifts the root's origin by the same delta under
the same generation (the seek already does); bounce's `is_root` branch
then collapses into the node branch (top = origin + a0, span = effective
cycle); the S21 lookup and the UI's seqDims read the owning stack's
origin. Cleaner still is D14-1 stage 2, where the epoch IS the root's
frame top. Days. Risk: medium. Benefit: high.

**D7-3 (+D13-6, D8-17) — high — The root is persisted through a second
path** (`rootMuted/rootGain/rootPan/rootEffects/rootSequence`,
session_io.cc:546-571; loaded at audio_engine.cc:139-152 with its own
`SequenceScope` and load ordering) and its window, map, `windowDomain`,
`periodSource`, bypass and anchored origin are never persisted or
projected — audible in the engine, invisible in the UI, lost on reopen.
Serialize the root through `serializeNode` (`top["root"] =
serializeNode(root, …)`); keep only version/name/created/sampleRate/
qSamples/epoch at bundle level (I14); factor the generic tail of
`deserializeNode` into `applyNodeFacts(...)` and apply it to the live
root. Read-side compatible. Days. **D15-8 — high** — the persist
format's one-way doors: `version` written but never read (D7-5, hours);
the root a different shape (above); template Q counts as doubles (D7-4).
Close all three before B8 ships; each is read-side compatible today.

**D7-10 (+D14-14) — medium — needs ruling** — per-node metadata publishes
each fact twice (samples + Q) plus derived projections the UI does not
read (`launchPoint`, per-node `qSamples`/`effectiveQuantum`, per-clip
`anchored`/`isPlaying`), and the UI reads `effectiveQuantum` IN
PREFERENCE to the island Q at lane_body.js:704 and keeps a
min-over-nodes fallback — a second law for one island fact (I14). Delete
the unread keys, publish `quantum`/`epoch` on the island root only, delete
`computeEffectiveQuantum`. Question: keep the Q-form keys for the UI, or
samples only? Day. **D14-10 — medium** — `ClipNode::sample_rate` is a
stale per-clip copy of the device rate and WAV headers are written from
it (session_io.cc:134); after a device-rate change every header is wrong.
One island rate; delete the field. Day (see D7-6 for the ruling).
**D14-12 — medium** — `collapse_origin_shift_` is declared to mirror
`content_base_` exactly, yet `spliceToMap` resets the base without the
markers (clip_node.h:386-390) and leaves `collapsed_from_` standing, so
the delete-time re-open later unwinds a spliced clip with pre-splice
markers. Delete the mirror; a splice clears the markers and the inverse
restores them. Hours. **D14-6 — low** — `ProcessContext` copies 31 fields
per stack per seam run; a third are per-callback constants and `island`
duplicates `snap->entries[0].node`; split into `const BlockFacts*` +
by-value `ScopeFacts` after D14-1. Day. **D14-16 — low** — `midi_armed`
encodes one engine-wide selection as N per-node flags kept single by a
sweep over the ATTACHED tree; a Remove/undo pair yields two armed nodes.
Scrub the detached subtree at Remove, or hold one `midi_target_` on the
engine. Hours.

---

## 3. The supporting core

### 3.1 Persistence

- **D7-1 — high** — the mirror judges take-file currency by LENGTH
  (session_io.cc:92-98): a collapse to `[Q, 2Q)` after a mirrored collapse
  to `[0, Q)` (same length) skips the WAV; on reload the clip plays the
  wrong bar. `take_files_dirty_` already exists as a partial second truth.
  Make it the ONE truth for every message-thread content-frame mutator;
  delete the length probe. Hours. Benefit: high.
- **D7-2 — medium** — take WAV rewrite is delete-then-write
  (session_io.cc:100-112): a crash or disk-full mid-rewrite destroys a
  COMMITTED take, against projects.md's "at most the take in flight".
  `juce::TemporaryFile` + `overwriteTargetFileWithTemporary`. Hours.
- **D7-6 — high — needs ruling** — no sample-rate guard on load
  (session_io.cc:588-590): a bundle from another device rate plays 8.8 %
  slow/fast, built-in fx are prepared at the file rate while revived VST3s
  get the device rate, and the next mirror tick re-stamps `sampleRate`
  with the device rate while headers keep the file rate. Question:
  refuse, warn, or resample? Recommend refuse with a message for 1.0
  (import already resamples; sessions can follow). Day.
- **D7-4 (+D3-3, D8-6) — medium** — the sequence `Step` block is written
  and read three times in three encodings (session QTime, template
  doubles + `llround`, bridge samples) and rescaled twice more; `lenQ`
  means an exact rational in sessions and a lossy double in templates.
  One `Sequence::stepVar`/`readStep` pair. Day.
- **D7-5 — medium** — `version` is written but never read; a future
  incompatible bundle loads as a plausible session and the mirror
  overwrites it 3 s later. `kSessionVersion` + refuse newer. Hours.
- **D7-15 — medium — needs ruling** — no byte-level save→load→save
  idempotence test; two holes would fail it today. One golden-bundle test
  exercising every key. Day.
- **D7-7, D7-11, D7-14 — low** — derived facts persisted (`hasAudio`, the
  active MIDI take twice, a takes count); five partial persistence lists
  in docs, none matching `serializeNode`; `duplicateProject` copies then
  FULL_REWRITEs every WAV.

### 3.2 The sequencer

- **D8-1 — critical — An orphan cued step hangs the audio thread.**
  `finalize` sets `any_cue` from EVERY step, reachable or not
  (sequence.h:115-117); `runAround`'s walks stop only at an off visit or a
  cued VISIT (:339-345); with a mask on across every reachable visit (the
  `~0ull` mask every row-less child inherits) and a cued step absent from
  the program, neither the fast path (:379, :412-414) nor a cut fires and
  the walk never terminates — in `cornerDistance` every block
  (stack_node.h:483) and in `gainAt` (stack_node.cc:615). Reachable: cue a
  step, then re-route its predecessor's successors; `setSequence` does not
  refuse it. Confirmed by reading and by a standalone reproduction of the
  walk, not by hanging the binary. Fix: derive `any_cue` inside the walk
  (`any_cue |= steps[step].cue` per visit) so it means "some VISIT is
  cued", and bound both walks by `n` iterations as a defensive invariant.
  One test. Hours.
- **D8-4 — medium — needs ruling** — the cue map is stated three times
  (`songToContent`, used only by tests; an inline re-base in
  `childContext`, stack_node.cc:427; a hand-composed audition map at
  :438) because `TimeMap` has no compose operator; composition.md:110-111
  states the formula with an `a0` §13 does not have. One
  `contentOfVisit(k, rel)` + `cueMapOfVisit(k)`; fix the doc. Question:
  should the cue become a real `TimeMap` layered under the authored one
  (composition.md §2's phrasing), which would also give D1-2's composer
  one law? Hours.
- **D15-2 — medium — needs ruling** — cues re-base to the SONG top
  (`O + a0 + (songRel − stepStart)`), not the child's own top; a child
  whose frame top is not ≡ the stack's origin enters each cued visit
  mid-phase; sequencer.md §3 ("from its own top") and composition.md §2 /
  sequencer_tests.cc:1533 ("song top") disagree, and the only pin has
  both origins at 0. Rule it (an S-series ruling); either way build the
  origin-move verb (D15-14).
- **D8-10 — medium** — only the program is golden-pinned across C++/JS;
  the gate envelope, cue map, fades and corner distance have unpinned JS
  re-implementations (view_model.js:571-640). `sequence_envelope_cases`.
  Day.
- **D8-13, D8-15 — low** — loaders silently truncate past `kMaxSteps` and
  drop zero-length steps while the verb refuses (needs a small ruling on
  which); `finalize()` is a convention, not a type.
- The C2 per-step fades are in the right place: the gate envelope, not
  content or the rack (`rampsOf` floors at the anti-pop micro-fade; the
  mask-aware `cornerDistance` keeps block splits exact). The seven JUCE
  assertion lines are UTF-8 bytes in `const char*` test-message literals
  in tests/sequencer_tests.cc (D10-6), five committed in eed4f30 and two
  in the working tree — not a fades defect.

### 3.3 UI purity and the mirrors

- **D9-1 — high** — the mock is a third, self-pinned implementation of
  the composition laws (~3,500 lines: settleAnchors, through-map arm,
  commit re-base, Q13 group collapse, continuity riders, sequences,
  takes, import, bounce); the golden vectors pin only the primitives; the
  one engine-derived pin (ui_contract_capture.json, gitignored, 657 KB) is
  written as a side effect of every C++ run and its consumer skips with
  exit 0 when it is absent. Make the mock a REPLAYER above the primitives:
  a scripted capture harness in tests/ui_contract_tests.cc (protocol verbs
  + advance steps run through the real engine, every poll dumped),
  captures committed under shared/, engine_replay and e2e driven from
  them; hand-written mock logic only for what the engine cannot answer
  offline. Week+. Benefit: high.
- **D9-12 — medium** — fixture-only fallbacks are second laws in
  production code (min-over-nodes Q, `definerStackOf`, program unroll,
  `epoch := root origin`; view_model.js:832, :874, :735, :2049); make
  `quantum`, `islandEpoch`, `definerId`, `program` required in the
  published shape and delete the fallbacks. Day. Benefit: high.
- **D9-2 (+D9-15) — medium** — `retakes` is inferred UI state; a retake's
  live bar length and pending arm mark are re-derived from the display
  playhead. Publish `retake`, `captured`, `pendingStartAt`. Day.
- **D9-3 — medium** — group take marks fold by the CURRENT cycle, clip
  marks by their heard cycle at arm (Q14b); composition.md §9 states a
  third. Store `context_cycle` on the stack at its anchoring event; ONE
  take-mark rule in timeline_model.js. Day.
- **D9-8 — medium** — `composite_waveform.js` and `lanePeaks` re-implement
  tiling/anchoring in pixel space with their own fallbacks (I2); have the
  VM emit member slices and reduce the compositor to a rasterizer. Days.
- **D9-9, D9-10, D9-6 — medium/low** — the sequencer grid restates the
  frame-health verdict in its drag preview; `auditionOwner` is a UI copy
  of engine-owned state (Esc fails to release an S21 auto-target); Space
  holds a deferred pause in page state with no engine verb; the drag pin
  folds the raw island clock in the UI (sanctioned, bounded).
- **D9-11 — medium** — display laws 2 and 11 are convention-only; law 1's
  replay silently skips without the capture.
- **D13-17, D13-14 — low** — `StackNode::getWaveform` is dead (the UI
  composites in JS); lane indentation is capped at depth 2 in four places
  while the engine has no limit.

### 3.4 Tests

- **D10-5 — medium** — performance.md §1 has no automated enforcement:
  no allocation guard, no sanitizer option, no threaded test, no
  `enable_testing`/`add_test`, no CI; `scripts/full_build.sh` builds only
  the app. Concretely: override global `operator new/delete` in
  test_runner.cc to `jassert` while a `g_in_audio_callback` flag is set,
  route every test callback through one helper that sets it — the whole
  suite becomes a no-allocation proof of the callback; `CELESTRIAN_
  SANITIZE=address|thread|undefined`; `add_test` for the three suites.
  Days. Benefit: high.
- **D10-4, D5-10 — medium** — no test runs the callback concurrently with
  message-thread edits; nothing pins the seqlock protocols, the origin
  generation gate or retire-vs-publish ordering (D5-1 would have been a
  20-line test). One tests/lockfree_tests.cc with a deterministic
  generation-gate case and one seeded threaded stress test under the
  sanitizer option. Days. Benefit: high.
- **D10-7 — medium** — no property/differential test of the kernel
  equation in C++; the fuzzer fuzzes the mock; no test island deeper than
  2. tests/kernel_property_tests.cc: seeded random islands of depth 0–3
  through the real engine, assert live == bounce (Q19 at every depth),
  live == a heard-index prediction, and wrap-in-a-group is sound-neutral
  (I15). Week+.
- **D10-1 (+D10-16) — medium** — tests/test_utils.h is a hand-written
  second implementation of `renderContext` that omits `is_playing` and
  `sample_rate` (57 hand-written `is_playing = true` lines; ~64 of 76
  lone-clip tests run on the test-only 44100 default). Call
  `engine_internal::renderContext` from the harness; drop the default.
  Day.
- **D10-9 — medium** — golden vectors are hand-authored with no
  generator; `sequence_program_cases` were produced by the JS mirror (so
  C++ is pinned to JS, not to the spec). A `--write-golden` mode on the
  test binary makes the engine the single generator. Day.
- **D6-16 — medium — needs ruling** — no round-trip symmetry test for the
  edit algebra (apply → undo → redo reproduces the serialized graph, with
  a seek between). take_undo_tests.cc:113-120 has an abandoned no-op
  bit-identity stub. A checker over every `Edit::Kind`. Days. Benefit:
  high.
- **D1-12, D2-3, D3-6, D4-16, D7-15, D8-10, D15-17 — medium** — the
  specific unpinned points: one-shot GROUP with a non-dividing shot,
  heard-index at depth 3, continuity under an ancestor map, nested and
  one-shot bounces, the effective-period chain across C++/JS, a
  structural edit on a hot clip, a double commit, save→load→save bytes,
  the gate envelope, any sequence at depth ≥ 1 or on a stack whose origin
  is not ≡ the epoch (no `setAnchor` anywhere in tests/).
- **D10-6 — low** — seven `juce_String.cpp:327` lines from UTF-8 bytes in
  `const char*` literals (sequencer_tests.cc:1039, :1110, :1266, :1310,
  :1401, :1403, :1486); the documented zero-assertion state regressed and
  nothing pins it — make assertion output fail the run (D10-10).
- **D10-2, D10-3, D10-8, D10-10, D10-11, D10-12, D10-13, D10-15 — low** —
  a lone `ClipNode` as island root is a configuration the engine never
  runs (56 sites); `driveFrom` hands a nested node the ROOT's context;
  I15 unpinned, I3 pinned only at t = 0 and depth 0; no section filter or
  seed; twelve wall-clock sleeps in e2e; the "expansion does not change
  the sound" sections cannot toggle anything; device_service.cc,
  main_component.cc, plugin_editor_windows.h have no direct test; a
  deleted `soloedId` field lives on in the JS fixture.

### 3.5 Structure and API surface

- **D12-3, D12-4, D12-5 — medium — needs ruling** — the kernel equation
  cannot be compiled without JUCE: heard_index.h and the snapshot folds
  are written over `AudioNode`, which pulls `juce::String/Uuid/var/
  MidiBuffer` through audio_node.h:25-32; there is no library target, so
  every engine TU compiles twice and a JUCE include in a kernel header
  gets no build-level signal; the UI projection (`getMetadata`, juce::var
  with UI key names) lives inside the node classes. Stage: (a) delete
  `clipHeardIndex`/`memberHeardIndex` and move `buildGraphSnapshot` to a
  builder header so heard_index.h and graph_snapshot.h depend on
  audio_node.h alone; (b) `src/node_projection.cc` with
  `juce::var projectNode(const AudioNode&)` over public getters, removing
  `getMetadata` from the node classes; (c) `add_library(celestrian_timing
  INTERFACE)` with NO JUCE module linked — the build then fails the moment
  a kernel header includes JUCE; (d) a `NodeFacts` base (origin, anchored,
  active map, intrinsic, type) that the equation compiles against.
  Question: is a JUCE-free kernel target wanted for 1.0? Recommend (a)–(c)
  now, (d) with D1-3. Days.
- **D12-1 — medium — needs ruling** — `AudioEngine` is eight objects
  sharing one class for access to private state (908-line header, ten
  TUs, disjoint slices). A6 chose one class, eight files. Question: split
  further for 1.0? Recommend only the two zero-kernel-risk value types
  now — `EditHistory` (undo_/redo_/depth/shiftAbsolutes/clear over a
  `GraphReclaimer&`) and `DeviceService` — and leave Island/root as the
  coupled core until D14-1 stage 2.
- **D12-6 — medium** — `AudioNode` exposes 24 public data members and
  external code stores into them directly (session_io.cc:436, :384-385;
  edit_log.cc:423; transport.cc:94); the two publication disciplines the
  kernel depends on (the origin gate, "content last, then sound") are
  enforced only by each writer's good behaviour — D12-7 is the drift.
  Add the missing verbs, route the 14 engine-side raw stores, then the
  tests. Days.
- **D12-14 — medium** — `getGraphState() const` mutates through
  `const_cast` and the take-storage grower runs ONLY from the WebView's
  poll (transport.cc:125): a throttled poll past the headroom (60 s at
  48 kHz) auto-finishes the take at the committed wall. A non-const
  `tick()` called from the bridge handler AND from the timer. Hours.
- **D12-17 — medium** — `ClipNode` (2971 lines, ~85 public methods) mixes
  the audio-thread contract with the take list, take edits (~330 lines
  inline in the header) and peak projection. Split by FILE, not by API:
  src/clip_node_takes.cc and a projection TU. Day.
- **D13-10 — medium** — eleven ad-hoc recursive walkers with
  `dynamic_cast<StackNode*>`; one `forEachDescendant`. Day.
- **D13-4 (+D6-7) — high** — the Q13 definer predicate is restated ~18
  times across map_edits.cc, transport.cc, take_service.cc and edit_log.cc
  with drifting gate sets (the `definerId` publication omits
  `hasActiveTake` and `auditionActive`, which the VM re-adds — I6 by
  compensation), plus a VM twin and a mock twin. One
  `engine_internal::definer(root)` and one `buildDefinerRetrim(...)`;
  `setLoopPoints(u, s, e)` literally `setSegments(u, single(s, e))`.
  Days. Benefit: high.
- **D12-2, D12-11, D12-12, D12-15, D12-16, D12-18, D12-21 — low** —
  internal methods in `public:` and a dead alias; silent truncation at
  `kMaxSegments`/`kMaxSplitChannels` where JS refuses; sentinel-mode
  parameters (`commitRecording(nullptr)`); five const_casts from missing
  const overloads; bridge arity in three places disagreeing with
  protocol.js in six registrations; a comment claiming "no virtual on the
  audio thread" beside virtual calls; `ForTest` hooks handing out
  non-const nodes.

### 3.6 Docs drift

| Doc | Claim | Code | Fix |
|---|---|---|---|
| composition.md §8, design_language.md:269-270 | the definer-stack twins and `memberHeardIndex` are deleted | all present (D6-1) | do D6-1; until then say "pending" |
| design_language.md Q13-for-groups :548-563 | member origins STAY at a group collapse; names `CollapseGroup` | origins MOVE (edit_log.cc:185-186) | dated SUPERSEDED line → composition.md §5 (D11-2) |
| time_maps.md content-frame-law section | names deleted riders | law now by construction | SUPERSEDED banner → composition.md §2/§4/§5 (D11-2) |
| composition.md §3 :134-135, tasks.md A2 | "five implementations" / "one fold + twin" | three C++ + two JS (D2-1) | true the count (D2-12) |
| composition.md §3 context_loop row | two consumers | neither reads it; only `armTarget` (D2-4) | fold the row |
| composition.md §2 :110-111 | cue formula with `a0` | §13's formula has none (D8-4) | state once |
| composition.md §9 | group take mark = `(origin − epoch) mod frame` | Q14b folds clips by contextCycle (D9-3) | "mod contextCycle" |
| design_language.md §1 rows 27/33/34, §3 E-B/E-C | context loop, one-shot, composite, epoch-anchored phase | predate the period law, Q5, Q18 (D11-5) | true to composition.md §3; SUPERSEDED line on E-C |
| .agent/glossary.md | "compact copy" | pre-Q18 on Origin/Time-map, ahead on Composite/One-shot (D11-6) | reduce to the pointer + units line |
| docs/README.md :16/:33, sequencer.md :21-23 | "steps 1–5", "UI pending", "Next: step 5" | steps 1–6 built, takes UI shipped (D11-9) | one status token each |
| performance.md :101 | "Known residuals: none" | D5-1, D5-2, D12-10, D5-4 (D5-13) | honest residuals list |
| performance.md §3 :218-222 | capture window reaches back into the ring | window start ≥ `input_clock` (D4-13) | rewrite; decide the ring size |
| performance.md §3/§7 | two-term compensation inside `ClipNode::process` | one pre-folded field (D11-11) | one sentence |
| audio_engine.cc:53-56, audio_node.h:514-515, midi_input_queue.h:56-57 | publish-then-retire; one map read per block; queue sizing | the first two are not true today (D5-13); the sizing holds only by JUCE's growth headroom (D5-6) | fix D5-1/D5-4 or state the rule; derive the buffer size from `kCapacity` |
| graph_snapshot.h:41 | "no virtual on audio thread" | folds call virtuals (D12-18) | say what the cache is for |
| kernel.md §2 table, §4 | pre-migration rows; roadmap prose; a function that does not exist (composition.md:127) | — (D11-7, D11-8) | archive §1/§3/§4/§5/§6 as tasks.md proposes; keep §2 |
| bounce.md | two caveats | three more: the detach fires device stop/start hooks, DSP scratch resumes from bounce-left state, a nested target renders in its OWN frame (D5-12) | add the caveats; ruling on nested semantics |
| ui.md placement table | 16 of 74 verbs, resolved 2026-07 fixes (D9-14) | — | regenerate from protocol.js |
| takes.md, vst3.md §6, session_io.h, project_manager.h | five partial persistence lists (D7-11) | none matches `serializeNode` | one list, generated or pointed at |
| design_language.md :80-83 | a test asserts expanded == collapsed | no such test in that form (D10-12) | "by construction: no expansion state exists" |
| .agent/tech.md:79, agent.md:33, :11, bridge.js:22 | `setHtml`; logs reach stdout; ruling range (D11-13) | — | fix |
| design_language.md Q2 pointer, engine_lcm_guard.md:59, tasks.md line count | renumbered question, wrong mock file, stale count (D11-14) | — | fix |
| code comments (ui/js ×8, "phase N" ×~120) | audit item numbers and phase citations (D11-15) | style.md bans item numbers; phases are dated history | needs a ruling on "phase N" |

Every ruling number cited in code resolves to an indexed ruling; Q21 has
no home outside the index pointer (D11-16).

---

## 4. Fractality scorecard (I5)

| Feature | Engine | UI | Mock | Tests | Verdict |
|---|---|---|---|---|---|
| Loop window, cut map | fractal (`AudioNode` map) | fractal (A1: group lanes offset by take mark) | fractal | depth ≤ 2 | keep; add depth-3 pins (D15-17) |
| Lock-collapse (Q13) | TWO laws, different gates (D6-1) | — | group re-open twin | each law pinned | debt D6-1 |
| Definer predicate | ~18 restatements (D13-4) | VM twin + gates re-added | mock twin | — | debt D13-4 |
| One-shot (Q5/Q18) | stack fold wrong (D1-1); sequence leg skipped (D2-5) | dashed tile; includes sequence | — | dividing shot only | debt D1-1; ruling D2-5 |
| Takes, comping | group new-take direct children only (D13-7); no group take selection (D15-7) | chip hidden on group lanes | direct-only | — | debt; rulings OQ10 (D15-16 says the code already answers it) |
| Fx chain, gain, pan, mute | fractal | fractal | fractal | pinned | keep |
| Solo (Q16) | fractal by snapshot walk | fractal | — | solo_tests | keep |
| Sequences, gates, fades | fractal in render; song position epoch-anchored in S21 lookup (D15-1) | seqDims tiled from epoch (D15-1) | — | depth ≥ 1 untested (D15-17) | partial; D15-1 |
| Cue steps | song-top re-base (D15-2); three statements (D8-4) | — | — | both origins at 0 | ruling D15-2 |
| Radio (S12) | root-only | root-only | root-only | pinned | principled (S12) |
| Bounce (Q19) | root: cycle from epoch; node: period from origin + a0; nested renders in its own frame | — | mirrored | root golden only | principled; document (D5-12); cap (D2-8) |
| Import | stack target gains a child | drop on any lane | mirrored | pinned | keep |
| MIDI clips | fractal | fractal | — | — | keep |
| Monitoring (Q20) | clip-only (D13-15) | clip-only | clip-only | — | debt (low) |
| Templates | group template drops periodSource/gain/pan/fx/mute (D13-16) | — | — | — | debt (low) |
| The root as a node | second persistence path (D7-3); island fields on every stack (D14-1); two frame tops (D15-1) | root frame = epoch | — | — | debt (structural) |
| Undo | Combine/Explode not a pair (D6-6); riders (D6-9); no round-trip law (D6-16) | — | third impl | per-kind only | debt |
| Take marks | — | clip: contextCycle; group: current cycle (D9-3) | — | — | debt (D9-3) |
| Nesting depth | unbounded, cast-free | indent capped at 2 (D13-14) | — | deepest 2 | debt (low) |
| Composite waveform | `StackNode::getWaveform` dead (D13-17) | JS composites with its own tiling (D9-8) | returns [] | — | debt |
| Window toggle mid-take | refusal gated on `NodeType::Stack` (D13-11) | — | mirrors | stack only | debt (low) |

---

## 5. Roadmap readiness

- **Warp (D15-3).** A rate term on the same primitive. Blockers: the
  slope-1 leaf read (clip_node.cc:624-626), the 1:1 heard-sample hand-down
  (stack_node.h:501-503, `childContext`) and integer `throughMapDest`
  (timing.h:180-181). Keep INNER positions integer and put the rational in
  the rate. Prepare now at low cost: a `rate` QTime on `ProcessContext`
  (identity) threaded through `childContext`/`forEachSeamRun` with no
  consumer; `TimeMap` heard-length through one `heardLen(seg)`; reserve
  `rateQ` in the segment shape (additive). Do not add a rate field to the
  map without a consumer.
- **Islands (D15-4, D14-1).** Single-island assumptions are concentrated
  and enumerable (engine_internal.h:35-52, island_geometry.cc:501-511,
  session_io.cc:349-352, the root branches in transport/bounce/
  map_edits). Q10 holds. Doors to open now: island facts re-scoped by
  `childContext` for a stack with stored Q; an `island` uuid on `Edit`;
  rename the three "root only" rules to "island root" with one
  `islandRootOf(node)`. D14-1 stage 2 is the real move.
- **Serial connections (D15-2, D15-14).** The program + cue re-base IS
  the serial time-map kernel.md §4 promised; what is missing is the
  origin-move verb (open question 9: recommend YES — whole-Q steps,
  refused under a live take, undoable via `setsOrigin`/`iorg`, drag the
  take mark on clip and group lanes alike) and a ruling on the cue target.
- **Multi-range loops.** Multi-segment maps with conservation-of-loop-
  length checked once are already this; nothing to prepare.
- **ZUI (D15-11).** The VM is a flat lane list keyed on the root frame;
  `focusedId` is published but unread; D1-2's composed received clock is
  the projection a focus view needs.
- **Automation (D15-12).** Structurally ready: an envelope is
  `gain(inner(t))`, a pure function of the node's own inner position
  applied at the output stage, block-split at corners exactly as
  `gainAt`/`cornerDistance` already do.
- **One-way doors (D15-8, D7-5, D7-4, D6-8).** `version` unread; the root
  a different shape in the file; template Q counts as doubles; absolute
  clock values in the log. The first three are read-side compatible to
  close today; do it before B8.
- **Open questions answered by the code (D15-13, D15-15, D15-16).** OQ5:
  pause/resume is right, "seek to top" is a gesture. OQ7: today's dims
  are the right resting law; the true unroll belongs to the focus view.
  OQ10: a per-member retake exists and keeps the group's definer status
  by construction. OQ11: import onto a committed slot cutting to the
  period is the takes law; a longer file is a new clip at the drop.

---

## 6. Recommended order of work

Each item names its finding ids and what "done" means. Suites green after
every step (C++ Debug binary first, then `npm test`, then Playwright).

> **Status 2026-09-08 — Tier 1 LANDED** (all three suites green; the
> seven `juce_String.cpp:327` lines are gone). Notes against the "done"
> definitions below: D5-2's hammer (tests/seq_lock_tests.cc) runs
> without TSan until D10-4 lands; D6-4 (seek reconciles) has no
> dedicated test — it mirrors record/undo/redo; D3-2's JS routing covers
> production modules, the hand-rolled folds in ui/js/tests/*.mjs are
> test-local helpers and were left. Also landed with D4-1: a refused
> structural undo/redo (hot node) now KEEPS its log entry, like the
> island-facts refusals. Docs: performance.md §1 carries the D5-1
> stamp-after-publish and D5-2 protocol paragraphs.
>
> **Status 2026-09-08 — Tier 2 LANDED except D4-7** (all three suites
> green). D1-1/D1-3/D1-2: `timing::innerAt` + `forEachContentRun` are
> the one equation (both clip loops, both playhead writes, `inRest`,
> `innerOf`, `forEachSeamRun`, `childContext` — a one-shot stack now
> folds its child clock on the context cycle, G-2b pinned in
> one_shot_tests.cc); `heard::receivedAt` composes the ancestors
> (maps, one-shot folds, cue re-bases) and `nodeInner` is
> `ownInnerAt(node, receivedAt(node, t))`; `memberHeardIndex` and
> `clipHeardIndex` are gone; the equation is golden-pinned
> (`inner_at_cases`) on both sides. D6-1 (+D12-7, D13-9): one
> `Edit::Kind::Collapse` (`collapseNode`/`uncollapseNode`, one arm-time
> site, one re-open branch, one re-collapse branch), `liftAncestorsGated`
> is the one lift, leaves are anchored by construction, `frameOrigin`
> lives on AudioNode. D13-4: `engine_internal::definer(root)` carries
> every gate; `definerId` publishes it. D2-1 (+D1-7, D2-4, D2-9) under
> the D2-5 recommendation (a): `src/period_law.h` (one template, tree +
> snapshot providers), `calculateEffectiveCycleLength` := the snapshot
> law, `context_loop` deleted (arm grid = context_cycle), bounce and
> `oneShotFacts` read own(target); JS twin in timeline_model.js used
> by the VM and the mock; `period_law_cases` tree fixtures pin all
> three. NOT done: D2-1's "one JS intrinsicDuration" (the display-side
> commensurate laws in view_model.js are unchanged), D2-10, D2-14. The
> D2-5 answer was applied as the recommendation; the OWNER'S RULING
> (2026-09-08): "a one-shot stack with a sequence" is not a
> well-defined idea — revisit the concept later; treat the current
> behavior as provisional, not canon.
>
> **Status 2026-09-08 — D4-7 LANDED (standalone round).** Commit
> stores (origin, duration) only: no map is authored on a take
> (recorded, imported, or loaded — a legacy bundle's [0, D) is scrubbed
> to none at load). "Whole" now means NO window everywhere (collapse
> consumes to none, members whole = none, the definer re-trim riders
> whole members to none); the mock mirrors it. Deviation from the
> recommendation: the unsnapped stop's provisional [0, L) window is
> still written by the audio thread at commit (so the clip loops right
> from its first pass — a message-thread settle would loop the padded
> length for up to a poll), and `liftGroupWindow` stays as the settle
> that lifts a group take's sub-region onto the stack; the full-span
> carve-outs are reworded as the general "restricts nothing" fact
> rather than deleted (an authored or legacy full-span window reads the
> same). ~25 test pins of `loopEnd == duration` became `== 0`.

**Tier 1 — hours each, do now, no ruling needed.**
- D8-1 orphan cue hang — done: `any_cue` derived per visit; both walks
  bounded; the orphan test passes.
- D3-1 + D3-2 + D3-13 posMod — done: one overflow-safe fold, every
  hand-rolled fold routed through it, INT64_MAX pins.
- D13-8 Move into own descendant — done: refused at the applier and in
  the mock; graph, snapshot and log untouched.
- D5-1 retire-before-publish — done: `retireNode` parks; `publishGraph`
  stamps after the exchange; reclaimer-ordering test.
- D5-2 seqlocks — done: one `SeqLocked<T>` with fenced protocol; three
  loops replaced; a two-thread hammer test under TSan.
- D4-1 hot-clip structural edits — done: Move/Combine/Explode refuse like
  Remove; D4-16's Combine-of-two-armed test green.
- D6-2, D6-4, D6-6, D6-5, D6-12 — done: `iq` never holds an absolute;
  seek reconciles; Explode owns the stack; the anchor rider carries the
  map; combine/import reconcile.
- D7-1, D7-2, D7-5 — done: dirty flag is the one truth; temp-file
  overwrite; `version` refused when newer.
- D2-8 bounce cap; D14-3; D14-12; D14-13; D5-14; D12-14; D10-6 (the seven
  literals) — done as stated above.

**Tier 2 — kernel purity: state each law once, delete the copies.**
- D1-1 → D1-3 → D1-2 — done: `innerAt` is the only statement of the
  equation on either thread; `receivedClockAt` composes it; G-2b and a
  depth-3 golden pass; `memberHeardIndex` gone.
- D6-1 (+D12-7, D13-9) — done: one `Collapse` kind for clip and stack;
  the §8 list is true; Q13-for-groups points at composition.md §5.
- D13-4 — done: one `definer(root)`; `definerId` carries every gate.
- D2-1 (+D1-7, D2-4, D2-9, D2-10, D2-14) after the D2-5 ruling — done:
  one `periodFold` with two providers; `context_loop` deleted; the chain
  golden-pinned as tree fixtures (D2-3) on both sides.
- D4-7 — done: commit stores (origin, duration) only; the carve-outs are
  gone.

**Tier 3 — the island and the root.**
- D14-1 stage 1 — done: no establishment on `addChild`; no scrubs;
  NESTED FACTS passes by construction.
- D15-1 — done: every epoch writer moves the root origin under one
  generation; bounce's root branch is the node branch; the S21 lookup
  reads the owning stack's origin.
- D7-3 + D15-8 — done: the root is a `stack` record in the file; the
  bundle carries only island facts; old files load.
- D14-1 stage 2 (`Island` record) — when Tier D islands start.

**Tier 4 — the recording lifecycle and stored state.**
- D4-9, D4-3, D4-4, D4-5, D4-8, D4-14, D4-10, D4-12 — done: one stop
  channel, one commit path with a CAS, a `TakeKind`, one "live"
  predicate, no view state in the callback, one message-thread commit
  settle.
- D4-11, D14-4, D14-10, D14-6, D14-16, D5-4, D5-5, D5-9 — done: the dead
  fields are gone, the take list holds content only, one island rate, the
  map and the clip frame are adopted once per block.
- D2-6, D14-15, D5-15, D4-6 after their rulings.

**Tier 5 — tests and enforcement.**
- D10-5, D10-4, D5-10 — done: allocation guard on the callback in every
  test; sanitizer option; lockfree tests; `ctest` runs all three suites.
- D10-1, D10-9 — done: the harness calls `renderContext`; the engine
  writes the golden file.
- D6-16, D7-15, D10-7, D15-17, D1-12, D3-6, D8-10 — done as stated.

**Tier 6 — structure and the mirrors.**
- D12-3/4/5 (a)–(c), D12-6, D12-17, D13-10, D12-1's two value types.
- D9-12, D9-2, D9-3, D9-8, D6-11's cheap step, then D9-1.

**Tier 7 — docs.** The §3.6 table, D11-17's single homes, the kernel.md
archive move, the persistence list.

---

## 7. Open questions for the owner

Each was flagged by the principle lens as uncovered by any ruling.

1. **Pause while a take is live (D14-15).** Refuse pause under
   `hasActiveTake()` like seek, with stop-at-boundary-then-pause as the
   UI gesture — or freeze capture with the clock? Recommend refuse.
   **RULED 2026-09-09: refuse** — part of the live-take gate
   (`AudioEngine::refusedUnderLiveTake`; design_language.md §5), which
   refuses EVERY time/content edit while a take is armed or capturing.
2. **A second arm under a live take (D2-6).** Refuse, or make the arm
   cycles per-take facts? Recommend refuse for 1.0.
   **RULED 2026-09-09: refuse** (one take at a time; scenario S27).
3. **A one-shot stack with an active sequence (D2-5).** Shot = whole song
   (map ▸ sequence ▸ D), intrinsic LCM, or refused? Recommend the song.
4. **Deleting the Q-definer while another take is live (D5-15).**
   Refuse (recommended), or defer the revert to settle?
   **RULED 2026-09-09: refuse** — no edits at all under a live take
   (the gate); a one-shot can never be the island's only content
   either (scenario S28).
5. **The cue's target (D15-2, D8-4).** Song-top replay (S9, today) or
   child-top replay (§3's letter)? A per-step flag is additive if both.
   And: should the cue become a real `TimeMap` layered under the
   authored one?
6. **Editable stack origin (OQ9, D15-14).** Recommend YES with the three
   constraints above.
7. **Cross-rate load (D7-6, D14-10).** Refuse, warn, or resample? And
   what does a device-rate change with committed content do? Recommend
   refuse with a message for 1.0.
8. **Compound edits vs riders (D6-9).** Adopt `Kind::Compound` as the one
   composition mechanism? Recommend yes, after D6-5/D6-6/D6-13.
9. **One `applyEdit` wire verb (D6-11).** Recommend the cheap step only
   for 1.0.
10. **A JUCE-free kernel target (D12-3/4).** Recommend (a)–(c) now.
11. **Splitting `AudioEngine` (D12-1).** Recommend only `EditHistory` and
    `DeviceService` for 1.0.
12. **Nested bounce semantics (D5-12).** As itself (own frame, ungated —
    today) or as heard through its ancestors? Recommend document "as
    itself" for 1.0.
13. **The island cycle before Q exists (D3-11).** One second of samples
    (today, undocumented) or no cycle?
14. **Group take selection and retake depth (D15-7, D13-7).** Fractal
    `selectTake`/`deleteTake` on a group; recurse retakes like arms?
    Recommend both.
15. **The per-node metadata's Q-form keys (D7-10)** and the arm grid at
    depth under a free-length song (D2-4's corner) — small, but rulings.
16. **Docs history (D11-8) and "phase N" citations (D11-15).** Archive
    kernel.md §1/§3/§4/§5/§6; is "phase N" a permitted citation form?

---

## Appendix A. Confirmed findings

Members in parentheses were merged into the canonical id. "where" gives
the first two code locations; the full evidence is in the audit
materials.

| id | sev | title | where |
|---|---|---|---|
| D1-1 | critical | One-shot STACK does not fold its child clock on the context cycle: firings after the first are phase-shifted whenever the shot does not divide the cycle | src/stack_node.cc:333-369, src/stack_node.cc:358 |
| D8-1 | critical | A cued but unreachable (orphan) step hangs the audio thread: runAround never terminates | src/sequence.h:115-117, src/sequence.h:335-345 |
| D1-2 | high | The message-thread equation is depth-1: nodeInner is fed the ISLAND clock for nested nodes and memberHeardIndex composes exactly one level | src/heard_index.h:44-53, src/heard_index.h:64-70 |
| D1-3 (+D1-13) | high | The render equation (t − O − a0) mod P → mapOffset is hand-restated eleven times, and the clip's audio and MIDI render loops are two full copies of the run splitter | src/clip_node.cc:604, src/clip_node.cc:684 |
| D12-10 (+D5-7) | high | Four 'maximum block' constants with two values (4096 / 8192), and every node keeps a grow-if-bigger path that allocates on the audio thread | src/stack_node.cc:25-31, src/stack_node.cc:519-524 |
| D13-4 (+D6-7) | high | The Q13 definer predicate is restated ~18 times across four engine files plus a VM twin and a mock twin, with different gate sets | src/engine/map_edits.cc:85-93, src/engine/map_edits.cc:131-138 |
| D13-8 | high | Move has no ancestor guard: reordering a stack into its own descendant detaches the subtree and inserts it into itself | src/engine/edit_log.cc:326-340, src/engine/verbs.cc:114-125 |
| D14-1 (+D4-2, D6-10, D7-8, D13-5) | high | Island facts are stored on EVERY StackNode and established by a third law (maybeEstablishQuantumFrom on addChild); I14 is held by scrubs | src/stack_node.h:514, src/stack_node.h:518 |
| D15-1 (+D8-3, D13-1, D13-2, D8-2, D8-18) | high | A stack's song position is origin-anchored in the engine but epoch-anchored in the UI grid/dims/fades, masterPos, seek, bounce, the mock and S21's step lookup | src/stack_node.cc:598-606, src/stack_node.h:373-383 |
| D15-8 | high | Persist-format one-way doors: version unread, island root a different shape, template Q counts as doubles | src/session_io.cc:544-566, src/session_io.cc:580-620 |
| D2-1 (+D1-8, D2-2, D2-11, D2-13, D8-7, D9-4, D9-5, D10-14, D11-10, D15-5) | high | The effective-period chain is stated four times in C++ plus two cycle wrappers and at least eight times in JS under three different laws; the copies already disagree | src/audio_node.h:649, src/stack_node.cc:148 |
| D3-1 | high | posMod's `((a % m) + m) % m` form overflows once lcm has saturated; every fold by the saturated cycle is signed-overflow UB on the audio thread | src/qtime.h:152-154, src/qtime.h:140-147 |
| D4-1 | high | Move/Combine of an armed or capturing clip is unguarded and cycles the island take counter through zero mid-take | src/engine/edit_log.cc:326-340, src/engine/verbs.cc:101-111 |
| D5-1 | high | Detached nodes retired BEFORE the snapshot that references them is republished, with reaping retire() calls in between (Combine, loadSession) | src/engine/edit_log.cc:392, src/engine/edit_log.cc:66-79 |
| D5-2 (+D12-9) | high | Three hand-rolled seqlocks (map, island triple, take table) with the same 16-attempt loop, three after-bound policies and memory orders that do not exclude torn reads on ARM64 | src/audio_node.h:517-542, src/clip_node.cc:1657-1700 |
| D6-1 (+D11-1, D12-8, D13-3, D15-6) | high | Q18's lock-collapse deletions did not land: CollapseGroup, collapseGroupNow/uncollapseGroupNow, the Insert/Remove group branches, the duplicated arm-time collapse and memberHeardIndex survive as a second law | src/edit.h:63, src/engine/edit_log.cc:162 |
| D6-2 | high | A seek does not shift the splice-collapse inverse's absolute origin (stored in `iq`) | src/engine/edit_log.cc:491, src/engine/edit_log.cc:523 |
| D6-6 | high | Combine/Explode is not an inverse pair: redo builds a NEW stack and silently truncates the redo branch | src/engine/edit_log.cc:354, src/engine/edit_log.cc:392 |
| D7-1 | high | Mirror judges take-file currency by LENGTH; equal-length collapses leave a stale WAV | src/session_io.cc:92-98, src/session_io.cc:126-136 |
| D7-3 (+D13-6, D8-17) | high | The root is persisted through a second path and its window, map, windowDomain, periodSource, bypass and anchored origin are never persisted or projected | src/session_io.cc:546-571, src/session_io.cc:569-570 |
| D7-6 | high | No sample-rate guard on load: a bundle from another device rate plays at the wrong speed | src/session_io.cc:588-590, src/session_io.cc:369 |
| D9-1 | high | The mock is a third, self-pinned implementation of the composition laws; the only engine-derived pin is a gitignored capture that skips when absent | ui/js/mock/state.js:296, ui/js/mock/state.js:437 |
| D1-7 | medium | The Q5 exclusion is restated at six C++ and seven JS call sites instead of living in the node's period contribution | src/stack_node.cc:138, src/stack_node.cc:155 |
| D1-11 (+D14-9) | medium | Per-node playhead telemetry is a stored projection with different meanings per node type | src/clip_node.cc:676-691, src/clip_node.cc:924-929 |
| D1-12 | medium | No test pins the kernel at the points where the copies diverge | tests/stack_origin_tests.cc:285-330, tests/one_shot_tests.cc:111-153 |
| D10-1 (+D10-16) | medium | The test-side context builder is a hand-written second implementation of renderContext that omits is_playing and sample_rate | tests/test_utils.h:67-96, tests/test_utils.h:101-113 |
| D10-4 | medium | No test runs the callback concurrently with message-thread edits | tests/test_utils.h:120-133, tests/callback_edge_tests.cc:259-284 |
| D10-5 | medium | performance.md §1 has no automated enforcement: no CI, no allocation guard, no sanitizer build, no lint, test target not wired to ctest | CMakeLists.txt:204-258, scripts/full_build.sh |
| D10-7 | medium | No property/differential test of the kernel equation exists in C++; fuzz_loop_region fuzzes the mock only; no test island deeper than 2 | ui/js/tests/fuzz_loop_region.test.mjs:45-49, tests/render_purity_tests.cc:71-81 |
| D10-9 | medium | Golden vectors are hand-authored with no generator; the one engine-produced fixture is gitignored and its consumer skips | shared/timing_golden.json, tests/timing_golden_tests.cc:72-75 |
| D11-2 (+D6-15, D11-4) | medium | Docs disagree with each other and with the code on what Q18 deleted | src/engine/edit_log.cc:179-187, src/clip_node.h:308-316 |
| D11-5 | medium | design_language.md §1 vocabulary and §3 examples predate the period law, Q5 and Q18 on four rows | src/stack_node.cc:479-489, src/audio_node.h:649-653 |
| D11-6 | medium | .agent/glossary.md is a drifting copy: Origin and Time-map still pre-Q18 while its source moved on | .agent/glossary.md:12, .agent/glossary.md:14 |
| D11-9 | medium | docs/README.md and sequencer.md's own header lag the shipped state | docs/README.md:16, docs/README.md:33 |
| D11-17 | medium | Laws stated in more than one doc home: the period law in eight places, the context loop in five, lock-collapse in four, islands in three | .agent/glossary.md:19 |
| D12-1 | medium | AudioEngine is eight objects sharing one class for access to private state | src/audio_engine.h:41-43, src/audio_engine.h:665-667 |
| D12-3 | medium | The kernel equation cannot be compiled without JUCE | src/audio_node.h:25-32, src/audio_node.h:172 |
| D12-4 | medium | No library target: every engine TU is compiled twice and there is nowhere to hang a JUCE-free kernel target | CMakeLists.txt:116-148, CMakeLists.txt:196-236 |
| D12-5 | medium | UI projection (juce::var with UI key names) lives inside the kernel node classes | src/audio_node.h:316-409, src/clip_node.cc:54-88 |
| D12-6 | medium | AudioNode exposes 24 public data members; external code stores into them directly | src/audio_node.h:720-833, src/session_io.cc:436 |
| D12-7 | medium | Two implementations of the ancestor origin lift — one gated, one not | src/engine/edit_log.cc:44-52, src/engine/edit_log.cc:185-186 |
| D12-14 | medium | getGraphState() const mutates through const_cast, and the take-storage grower runs ONLY from that UI poll | src/engine/transport.cc:116-125, src/engine/take_service.cc:87 |
| D12-17 | medium | ClipNode (~3000 lines, 85 public methods) carries take-list, take-edit and peak-projection responsibilities that are movable | src/clip_node.h:271-291, src/clip_node.h:330-388 |
| D13-7 | medium | Group new-take collects direct clip children only while group arm recurses | src/engine/take_service.cc:140-160, src/engine/take_service.cc:120-136 |
| D13-9 | medium | 'anchored = isClip \|\| isAnchored()' is restated four times because ClipNode never sets its anchor flag | src/heard_index.h:51-52, src/engine/island_geometry.cc:199-200 |
| D13-10 | medium | At least eleven ad-hoc recursive tree walkers with dynamic_cast<StackNode*> restate 'visit the subtree' | src/engine/verbs.cc:255-268, src/engine/verbs.cc:305-312 |
| D14-3 | medium | take_context_cycle_ is overwritten at a retake arm and not restored when the retake cancels | src/clip_node.cc:1199, src/clip_node.cc:1201 |
| D14-4 | medium | Inactive-take records carry dead copies of the slot's origin/duration/context_cycle that go stale after a seek | src/clip_node.h:425, src/clip_node.h:426 |
| D14-10 | medium | ClipNode::sample_rate is a stale per-clip copy of the device rate, and WAV headers are written from it | src/clip_node.h:965, src/clip_node.cc:32 |
| D14-12 | medium | collapse_origin_shift_ is declared to mirror content_base_ exactly, yet the multi-segment splice resets the base without the markers | src/clip_node.h:288, src/clip_node.h:795 |
| D14-15 | medium | Capture and arm evaluation run while the transport is paused, so a take can record against a frozen clock | src/clip_node.cc:171, src/clip_node.cc:174 |
| D15-2 | medium | Cue steps re-base to the SONG top, not the child's own top; no verb can move a node's origin to close the gap | src/sequence.h:273-284, src/stack_node.cc:420-431 |
| D15-3 | medium | Warp readiness: the rate term is blocked by the 1:1 clock hand-down and the integer per-sample read | src/time_map.h:29-117, src/clip_node.cc:619-626 |
| D15-4 | medium | Single-island assumptions are concentrated and enumerable; the per-subtree mechanism already exists on the message thread | src/engine/island_geometry.cc:490-514, src/session_io.cc:349-352 |
| D15-7 | medium | A group take is 'one performance, N microphones' at arm but N independent takes afterwards: no group-level take selection | src/engine/take_service.cc:137-160, src/engine/take_service.cc:505-560 |
| D15-14 | medium | Open question 9 (editable stack origin): recommend YES — the primitive exists, only the verb is missing | src/engine/island_geometry.cc:348-405, src/edit.h:145-146 |
| D15-17 (+D8-11, D13-13) | medium | No test exercises a sequence (cue, gate, fade) at depth ≥ 1 under a parent map or on a stack whose origin is not congruent with the epoch | tests/stack_origin_tests.cc:336-337, tests/stack_loop_tests.cc:138 |
| D2-3 | medium | No golden vector pins the effective-period chain across C++ and JS; the C++ parity test covers one two-clip fixture | shared/timing_golden.json:4, tests/graph_snapshot_tests.cc:70 |
| D2-4 | medium | context_loop is behavior-identical to context_cycle in every reachable state under I13 | src/audio_node.h:100, src/stack_node.cc:468 |
| D2-5 | medium | A one-shot STACK's shot length skips the sequence layer of the period chain; the UI includes it | src/stack_node.cc:171, src/stack_node.h:450 |
| D2-6 (+D4-15) | medium | Island cycle snapshots (lcm_before_take_, heard_cycle_at_arm_) are taken once per take-SET at the 0→1 arm | src/stack_node.cc:213, src/clip_node.cc:1349 |
| D2-8 | medium | Bounce has no span cap: a saturated or large effective period overflows the int buffer size | src/engine/bounce.cc:86, src/engine/bounce.cc:124 |
| D3-2 (+D11-12) | medium | Hand-rolled `((x % m) + m) % m` folds survive in six C++ sites and eight JS sites despite the 'never hand-roll' rule | src/clip_node.cc:604-605, src/clip_node.cc:898-899 |
| D3-6 | medium | Golden coverage gaps: posMod, foldPeriod, qcmp/qeq, subdivisionSamples, periodQ, lcm saturation and negative-origin launchPointFor | shared/timing_golden.json, tests/timing_golden_tests.cc:48-58 |
| D4-3 (+D14-11) | medium | A fifth, unnamed state (Settling) and the take KIND live outside RecState as sentinel values and flags | src/clip_node.h:922-925, src/clip_node.h:934-940 |
| D4-4 | medium | Two truths for 'a take is live': the root counter and the recursive child scan, and callers check both | src/stack_node.h:229, src/stack_node.cc:746-755 |
| D4-5 (+D14-5) | medium | The audio callback maintains recording VIEW state (frozen cursor base) by edge-detecting the take counter every block | src/engine/audio_callback.cc:158-186, src/audio_engine.h:707-709 |
| D4-6 | medium | MIDI compensation prefers the driver report over the measured round trip and otherwise guesses half of it, against I7 | src/engine/audio_callback.cc:139-146, src/engine/audio_callback.cc:133-137 |
| D4-7 | medium | Commit authors geometry: a full-span or sub-region loop window is written on every take | src/clip_node.cc:1444-1461, src/clip_node.cc:1462-1470 |
| D4-8 | medium | The commit event is hand-rolled twice (audio-thread commit + import) with the message-thread half only for recorded takes | src/clip_node.cc:1486-1505, src/engine/import.cc:252-273 |
| D4-9 | medium | commitRecording is check-then-store and reachable from both threads; the pre-Q first-clip stop commits on the message thread under a live capture | src/clip_node.cc:1398-1404, src/clip_node.cc:1384-1388 |
| D4-11 (+D14-2, D14-8) | medium | Dead and duplicated stored take state on the leaf: commit_master_pos and awaiting_start_at are write-only telemetry; live_duration_samples mirrors write_position | src/clip_node.h:962, src/clip_node.h:212 |
| D4-16 | medium | No test covers a structural edit on a hot clip or a concurrent double commit | tests/clip_node_tests.cc:524-543, tests/qtime_lock_tests.cc:598-625 |
| D5-4 (+D12-20) | medium | A stack's seqlocked time-map is read up to six times per block, separately by control and render | src/stack_node.h:441, src/stack_node.cc:182 |
| D5-5 | medium | Multi-field clip facts changed together are stored as separate atomics and read piecemeal by render; only origin<->epoch is generation-gated | src/clip_node.h:300-317, src/clip_node.h:360-395 |
| D5-10 | medium | No test pins the lock-free machinery: seqlock protocols, the origin generation gate, or retire-vs-publish ordering | tests/callback_edge_tests.cc:259-284, tests/graph_snapshot_tests.cc:100-106 |
| D5-15 | medium | The island-facts seqlock's single-writer discipline rests on eleven scattered hasActiveTake guards with no assertion at the writer | src/stack_node.h:159-165, src/stack_node.cc:204-207 |
| D6-4 | medium | seekTransport does not reconcile pending takes: a settled-but-unlogged take keeps a pre-seek epoch | src/engine/transport.cc:28, src/engine/transport.cc:35 |
| D6-5 | medium | settleAnchors re-expresses or clears a stack's pre-anchor map with no inverse; undo of the first take leaves the geometry moved | src/engine/island_geometry.cc:348, src/engine/island_geometry.cc:395 |
| D6-8 (+D12-13, D3-10) | medium | Edit is an untyped payload bag: iq/iepoch, b1, d1/d2, index and uuid2 each mean three or more things, int64 sample facts travel as doubles | src/edit.h:129, src/edit.h:139 |
| D6-9 | medium | Riders are a second undo mechanism; a generic Compound edit would replace eight rider channels and the log-top mutation | src/edit.h:138, src/edit.h:161 |
| D6-11 (+D9-7) | medium | The edit algebra is nearly closed (~26 kinds) but the bridge carries ~74 bespoke verbs, undoability is hand-listed in three places | ui/js/protocol.js:1, src/edit.h:38 |
| D6-16 | medium | No round-trip symmetry test exists for the edit algebra | tests/undo_tests.cc:178, tests/take_undo_tests.cc:100 |
| D7-2 | medium | Take WAV rewrite is delete-then-write: a crash or disk-full destroys a COMMITTED take | src/session_io.cc:100-112, src/session_io.cc:126-142 |
| D7-4 (+D3-3, D8-6) | medium | The sequence Step block is written and read three times in three encodings; `lenQ`/`fadeInQ` mean an exact rational in sessions and a lossy double in templates | src/session_io.cc:46-76, src/session_io.cc:617-667 |
| D7-5 | medium | `version` is written but never read: a newer or breaking file loads silently | src/session_io.cc:547, src/session_io.cc:577-615 |
| D7-10 (+D14-14) | medium | Per-node metadata publishes each fact twice plus derived projections the UI does not consume; the UI keeps a min-over-nodes fallback law for Q | src/audio_node.h:364-399, src/stack_node.cc:57-58 |
| D7-15 | medium | No byte-level save→load→save idempotence test | tests/session_io_tests.cc:220-228, tests/session_io_tests.cc:295-306 |
| D8-4 | medium | The cue map is stated three times: songToContent, an inline re-base in childContext, and a hand-composed audition map | src/sequence.h:273-284, src/stack_node.cc:419-446 |
| D8-10 | medium | Only the program is golden-pinned across C++/JS; gate envelope, cue map, fades and corner distance have unpinned JS re-implementations | shared/timing_golden.json:197-207, ui/js/view_model.js:571-640 |
| D9-2 (+D9-15) | medium | `retakes` is inferred UI state and a retake's live bar length / pending arm mark are re-derived in the VM from the display playhead | ui/js/app.js:50, ui/js/app.js:244 |
| D9-3 | medium | Group take marks fold by the current cycle, clip take marks by their heard cycle at arm — two take-mark laws, and composition.md §9 states a third | ui/js/view_model.js:1393, ui/js/view_model.js:1796 |
| D9-8 | medium | The composite waveform and lanePeaks re-implement the tiling/anchoring law in pixel space | ui/js/composite_waveform.js:243, ui/js/session_view/lane_body.js:702 |
| D9-9 | medium | The sequencer grid re-implements the frame-health verdict in its drag preview and mutates the lane optimistically between polls | ui/js/session_view/seq_grid.js:799, ui/js/session_view/seq_grid.js:803 |
| D9-10 | medium | View actions that change sound or transport: selection drives setMidiArmed, Space holds a deferred pause in UI state | ui/js/app.js:671, ui/js/app.js:688 |
| D9-11 | medium | Display laws 2 and 11 are convention-only, law 1's engine pin is optional, and law 9 carries two supersession notes | ui/js/session_view/sv_util.js:27, ui/js/tests/engine_replay.test.mjs:26 |
| D9-12 | medium | Fixture-only fallbacks are second laws living in production code: definer derivation, quantum min-over-nodes, program unroll, epoch = root origin | ui/js/view_model.js:832, ui/js/view_model.js:874 |
| D1-10 | low | Render-phase mutable inventory: all DSP scratch or telemetry except one request consumed inside render | src/audio_node.h:716-724, src/audio_node.h:753 |
| D10-2 | low | A lone ClipNode as island root is a configuration the engine never runs; island lifecycle events vanish into AudioNode no-ops in 56 test sites | tests/test_utils.h:35-38, tests/test_utils.h:77-82 |
| D10-3 | low | driveFrom hands a nested node the ROOT's context, not what its parent would compute | tests/test_utils.h:59-65, src/stack_node.cc:333-441 |
| D10-6 (+D8-9) | low | Seven JUCE assertion lines in the test run, all from juce::String(const char*) on UTF-8 bytes in sequencer test-message literals | tests/sequencer_tests.cc:1039, tests/sequencer_tests.cc:1110 |
| D10-8 | low | Invariant coverage matrix: I15 unpinned; I3 pinned only at t = 0 and depth 0; I4 no sample-level pin | tests/regression_tests.cc:463-525, tests/stack_origin_tests.cc:198-285 |
| D10-10 | low | Runner ergonomics: no section filter or seed, assertions are not failures, Debug-path gotcha documented in three places | tests/test_runner.cc:40-43, ui/package.json:7 |
| D10-11 | low | E2E flakiness sources: wall-clock sleeps restating source timing constants, a boot helper copied into three specs, one 1800-line spec | ui/e2e/session_view.spec.js:1463, ui/e2e/session_view.spec.js:1770 |
| D10-12 | low | The I6b 'expansion does not change the sound' sections cannot toggle anything; design_language.md claims a test that does not exist in that form | tests/stack_loop_tests.cc:47-51, tests/stack_node_tests.cc:243 |
| D10-13 | low | Coverage shape: device_service.cc, main_component.cc and plugin_editor_windows.h have no direct test | src/engine/device_service.cc, src/main_component.cc |
| D10-15 | low | JS fixture carries the deleted soloedId field | ui/js/tests/helpers.mjs:140-145, tests/audio_engine_tests.cc:171 |
| D11-7 | low | kernel.md §2 projection table keeps pre-migration rows and composition.md names a function that does not exist | src/heard_index.h:59, src/clip_node.cc:69 |
| D11-8 | low | Spec docs carrying history the tracker already proposes to archive | docs/kernel.md:183-205 |
| D11-11 | low | performance.md states the latency-compensation formula and its home wrongly | src/clip_node.cc:1028-1034, src/audio_node.h:73-77 |
| D11-13 | low | .agent files name a non-existent helper, the wrong log sink and an out-of-date ruling range | .agent/tech.md:79, .agent/agent.md:33 |
| D11-14 | low | Stale cross-references: Q2's tasks.md pointer, the lcm guard's mock file, a line count in the tracker | ui/js/mock/maps.js:151-166, docs/design_language.md:344 |
| D11-15 | low | Comment-hygiene residue after A9: refactoring-proposal item numbers survive in ui/js and 'phase N' citations dominate both trees | ui/js/view_model.js:2, ui/js/session_view.js:2 |
| D11-16 | low | Every ruling cited in code exists in the index; Q21 has no home outside the index pointer | docs/design_language.md:257-306 |
| D12-2 | low | Internal engine methods sit in public: and one dead alias survives | src/audio_engine.h:249-272, src/audio_engine.h:365-370 |
| D12-11 | low | Silent capacity truncation at kMaxSegments and kMaxSplitChannels; the JS side refuses where the C++ side truncates | src/main_component.cc:661-673, src/session_io.cc:444-452 |
| D12-12 | low | Sentinel defaults and boolean parameters carry modes that should be types | src/clip_node.h:196-199, src/clip_node.cc:1410-1412 |
| D12-15 | low | Five of eight const_casts stem from missing const overloads; render's const-ness holds by convention at the snapshot boundary | src/audio_node.h:467, src/audio_engine.h:591-592 |
| D12-16 | low | Bridge arity lives in three hand-maintained places and disagrees with protocol.js in six registrations | src/main_component.cc:96-125, src/main_component.cc:390-396 |
| D12-18 | low | GraphSnapshot::Entry comment claims 'no virtual on audio thread' while the folds call virtuals | src/graph_snapshot.h:41, src/graph_snapshot.h:97 |
| D12-21 | low | Test-only hooks hand tests non-const nodes, and tests write kernel facts directly instead of through verbs | src/audio_engine.h:181-193, src/clip_node.h:283-284 |
| D13-11 | low | toggleLoopWindow's mid-take refusal is gated on NodeType::Stack; a clip mid-take may flip its own window bypass | src/engine/map_edits.cc:374-379, src/engine/map_edits.cc:36-42 |
| D13-12 | low | Audio-thread type switch on child duration where the snapshot twin already handles clips | src/stack_node.cc:477-480, src/graph_snapshot.h:92-95 |
| D13-14 | low | UI indentation is capped at depth 2 | ui/js/session_view/lane_build.js:44, ui/css/session.css:728-730 |
| D13-15 | low | Software input monitoring (Q20) is clip-only at every layer with no group twin | src/engine/verbs.cc:323-329, ui/js/session_view/lane_build.js:225-241 |
| D13-16 | low | Group templates drop the subtree's gain, pan, fx, mute and period source | src/track_template.h:53-62, src/track_template.h:127-134 |
| D13-17 | low | Composite waveform is stated twice: StackNode::getWaveform is never fetched by the UI, which composites groups in JS | src/stack_node.h:64-67, ui/js/app.js:160-163 |
| D14-6 | low | ProcessContext copies 31 fields per stack per seam run; a third are per-callback constants and `island` is derivable | src/audio_node.h:55, src/audio_node.h:134 |
| D14-13 | low | preferred_input_channel / preferred_input_channel_right are plain ints written on the message thread and read on the audio thread | src/clip_node.h:967, src/clip_node.h:971 |
| D14-16 | low | midi_armed encodes one engine-wide selection as N per-node flags, kept single by an engine sweep | src/audio_node.h:756, src/engine/verbs.cc:308 |
| D15-11 | low | ZUI readiness: the view model is a flat lane list keyed on the root frame; focusedId is published but unread | ui/js/view_model.js:1916-1917, ui/js/view_model.js:2046-2075 |
| D15-12 | low | Automation as a hierarchical VCA is structurally ready; the missing piece is a per-node envelope over inner position | src/audio_node.h:775-790, src/audio_node.h:655-700 |
| D15-13 | low | Open question 7 (heard-frame unroll): today's dims are the right resting law; the true unroll belongs to the focus view | ui/js/view_model.js:1884-1890, ui/js/view_model.js:1453-1457 |
| D15-15 | low | Open question 5 (stop/play policy): pause/resume is right; expose 'seek to top' as a gesture | src/engine/transport.cc:20-26, src/engine/transport.cc:28-60 |
| D15-16 | low | Open questions 10 and 11 are already answered by the code's invariants | src/engine/take_service.cc:137-160, src/engine/island_geometry.cc:57-78 |
| D2-7 | low | Q-coherence has two undocumented bypasses: sequence step lengths and session load (no scrub) | src/engine/map_edits.cc:413, src/engine/map_edits.cc:481 |
| D2-9 | low | Three statements of the one-shot 'shot length'; bounce's differs from the render under a window | src/clip_node.cc:574, src/stack_node.cc:171 |
| D2-10 | low | Import computes the take's contextCycle by a second path instead of the arm snapshot | src/engine/import.cc:250, src/engine/import.cc:255 |
| D2-12 | low | Docs drift around the cycle table: wrong consumer list, wrong implementation counts, dangling references, stale twin names | src/graph_snapshot.h:117, src/audio_node.h:56 |
| D2-14 | low | Divisor periods (Q/k) are first-class in the engine but rounded up to Q by the JS commensurate fold | ui/js/timeline_model.js:151, src/timing.h:110 |
| D2-15 | low | JS lcm does not saturate and no test covers a saturated cycle's downstream | ui/js/math_utils.js:32, ui/js/view_model.js:45 |
| D3-5 (+D15-10) | low | The period/Q coherence predicate is implemented twice in island_geometry.cc, in map_edits.cc, three times in the mock and once in map_edit.js | src/engine/island_geometry.cc:209-213, src/engine/island_geometry.cc:523-525 |
| D3-7 (+D8-14, D12-19) | low | The 10 ms anti-pop fade constant is defined twice (int64 truncation vs double) and the fallback sample rate seven times | src/sequence.h:430-432, src/audio_node.h:687-689 |
| D3-8 | low | snapCommittedDuration keeps the last floating-point timing decision: the hysteresis threshold is (int64_t)(0.15 * (double)Q) | src/timing.h:28, src/timing.h:228 |
| D3-9 | low | nearestWholeQ (import placement) rounds a QTime through double llround, a second tie rule to toSamples | src/engine/import.cc:111-114, src/engine/import.cc:245-246 |
| D3-11 | low | The pre-Q 'one second' cycle fallback is derived from the sample rate at three sites | src/engine/engine_internal.h:56, src/engine/audio_callback.cc:177-179 |
| D3-12 | low | nextStopBoundary divides by quantum with no guard | src/timing.h:110-111, src/clip_node.cc:149-151 |
| D3-13 | low | Two semantics for a degenerate modulus: timing::posMod returns the input, heard::posMod returns 0 | src/qtime.h:152-154, src/heard_index.h:28-32 |
| D3-14 | low | JS toSamples on an unsnapped origin rational in a long session sits within a factor of two of the 2^53 bound | ui/js/qtime.js:13-17, ui/js/qtime.js:121-124 |
| D4-10 | low | Two readings of the epoch (raw vs Q-gated) and four accessors for one seqlocked triple | src/audio_engine.cc:90, src/stack_node.h:236-240 |
| D4-12 | low | Origin-gate adoption and the arm 'reached' predicate are copied instead of shared, with a magic 512 | src/clip_node.cc:104-106, src/audio_node.h:820-824 |
| D4-13 | low | performance.md §3 claims the capture window reaches back into the ring; the code never starts a window before the current block | src/clip_node.cc:1219, src/clip_node.cc:1044-1046 |
| D4-14 | low | Three stop channels and two commit walls where one of each would do | src/clip_node.h:947-951, src/clip_node.cc:127-136 |
| D5-3 | low | The graveyard is reaped only inside retire(): frozen while the device is stopped, last items linger until the next edit | src/audio_engine.cc:68-99, src/engine/device_service.cc:450-452 |
| D5-8 | low | The callback re-reads the island facts raw and the play flag twice after already holding the consistent context | src/engine/audio_callback.cc:121-123, src/engine/audio_callback.cc:156 |
| D5-9 | low | Buffers reachable through published content_/midi_ pointers are freed or reallocated inline, safe only via an unpinned is_playing gate | src/clip_node.cc:1296-1311, src/clip_node.cc:1266-1270 |
| D5-11 | low | Sequence gate resolution builds juce::String temporaries and does per-child string scans on the audio thread | src/stack_node.cc:614, src/audio_node.h:413 |
| D5-12 | low | Bounce side effects and divergences not recorded in bounce.md | src/engine/bounce.cc:113, src/engine/bounce.cc:181 |
| D5-13 | low | performance.md 'Known residuals: none on the audio thread' and three code comments state guarantees the code does not provide | src/audio_engine.cc:53-56, src/midi_input_queue.h:56-57 |
| D5-14 | low | RtLog's magic-static first touch can occur on the audio thread | src/rt_log.h:29-32, src/audio_engine.cc:34-48 |
| D6-12 | low | combineNodes and both import paths push to the log without reconciling pending takes (log order inverts) | src/engine/verbs.cc:123, src/engine/verbs.cc:126 |
| D6-13 | low | Authored geometry is silently cleared at arm and at Q establishment outside the take's undo entry | src/engine/take_service.cc:357, src/engine/take_service.cc:771 |
| D6-14 | low | Coalescing keys on Kind::Segments only; a live drag whose intermediate map is a single window emits non-coalescing LoopPoints entries | src/engine/edit_log.cc:34, src/engine/edit_log.cc:39 |
| D7-7 | low | Derived facts persisted: hasAudio, the active MIDI take stored twice, takes count beside the take arrays | src/session_io.cc:268-271, src/session_io.cc:275-278 |
| D7-11 | low | Persistence docs drift from the format | src/dsp/vst3_slot.cc:80, src/session_io.cc:506 |
| D7-14 | low | duplicateProject copies the folder and then FULL_REWRITEs every WAV; templates create an empty audio/ dir | src/project_manager.cc:228-238, src/session_io.cc:538-540 |
| D8-8 | low | The Sequence pointer is loaded five-plus times per block per stack, so a mid-block swap can split corners, gates and the cue re-base | src/stack_node.h:446, src/stack_node.h:283-287 |
| D8-13 | low | kMaxSteps and zero-length steps are handled two ways: the verb refuses, loaders silently truncate/drop and re-index | src/engine/map_edits.cc:415-418, src/session_io.cc:625 |
| D8-15 | low | finalize() is a convention, not a type: a Sequence can be published with stale derived tables | src/sequence.h:92-105, src/stack_node.h:276-278 |
| D9-6 | low | UI-held timing state during map gestures: the frame pin folds the raw island clock in the UI, and the VM defensively re-wraps masterPos | ui/js/session_view/drag_pin.js:14, ui/js/session_view/drag_pin.js:35 |
| D9-14 | low | docs/ui.md's placement table covers 16 of 74 verbs and still describes resolved 2026-07 fixes | docs/ui.md:38, ui/js/protocol.js:17 |

## Appendix B. Considered and rejected

Findings a verifier struck: either the cited code is what a ruling
mandates, or the claim did not survive re-reading the file. Listed so the
owner can see what was checked and found sound.

| id | claim | why rejected |
|---|---|---|
| D6-3 | The undo/redo logs store absolute clock values, so every seek rewrites history by hand | mandated by composition.md §5 (Seek row: "history absolutes shifted"); pinned by audit_regression_tests.cc E3 |
| D11-3 | Kernel headers and childContext/clip render comments still teach the pre-Q18 epoch-anchored window law | the "origin := cycle_epoch" sentence is the ruled empty case (composition.md §1); one stale line in time_map.h:13 remains and is covered by D11-17 |
| D11-18 | kernel.md §2 says "one stored origin" while the engine stores it twice (origin_samples + origin_rt_) | mandated by composition.md §5 (:204-207): the RT mirror is the generation gate, not a second fact |
| D1-4 | ProcessContext carries derivable and dead fields (map_heard_epoch, cycle_epoch, map_count) | the two anchors under a cue are mandated by S21; `map_count` IS dead (delete it with D1-12's test edits) |
| D1-5 | The unanchored-stack fallback is not purely the empty case; anchoring forces a lossy map re-expression | the re-expression is real (island_geometry.cc:361-401) but is audibly neutral in every reachable case and is what the ruling text mandates |
| D1-9 | bounce.cc restates the frame-top and scope laws by hand and disagrees with the live render for nested targets | mandated by Q19 / bounce.md "The span": an anchored nested target renders one effective period from origin + a0 (see D5-12 for the documentation gap) |
| D3-4 | The UI converts musical positions back to samples with Math.round(xQ * quantum) at four edit sites | mandated by Q12 D-T3/D-T4/D-T5: the UI hands the engine Q rationals; the engine owns the rounding law |
| D7-9 | The mirror rewrites session.json and probes every WAV every 3 s with no dirty flag | mandated by projects.md Rule 3 (continuous mirror, 3 s heartbeat) |
| D7-12 | contextCycle is a persisted per-take fact whose only consumer is display take-marking | mandated by Q14b: each take records its heard frame |
| D7-13 | Solo is a ruled per-node play control but is not persisted | mandated by Q16 and the "monitoring gesture" class (not undoable, not persisted) |
| D7-16 | Templates cannot smuggle geometry today, but the guarantee is by omission, not by a scrub | refuted: every geometry key is QTime decoded through toSamples, which returns 0 pre-Q; the two non-QTime facts have explicit scrubs |
| D8-5 | The root-only radio rule (S12) is enforced at three sites with two different outcomes | mandated by S12 and sequencer.md §14 (refuse on the verb, demote on load) |
| D8-12 | "A radio has no period" is not what the code does: it folds on the 256-visit horizon total | mandated by S12 / sequencer.md §14 ("the horizon total is what the root's frame folds on"); tasks.md C3 records the open decision |
| D8-16 | The audition index survives a same-count step reorder and silently re-aims at the neighbour | mandated by sequencer.md §11.10 (a resize keeps the audition; a count change clears it) |
| D5-6 | The live MIDI drain buffer is preallocated smaller than a full queue drain | refuted: the arithmetic is right (1024 × 9 = 9216 > 8192) but JUCE's `ArrayBase::ensureAllocatedSize` grows `ensureSize(8192)` to 12296 bytes and `clear()` never frees, so a full drain never allocates on the audio thread; hygiene only — derive the constant from `MidiInputQueue::kCapacity` |
| D9-13 | The window cursor and playhead are per-element clocks kept honest only by correction constants | refuted: display law 10's CODA mandates exactly this dead-reckoner, corrected each poll, velocity observed |

# Loop-region / time-map audit (2026-08-30)

Scope: everything between a bracket drag and the sample that reaches
the speaker — `window_edit.js` / `map_bands.js` / `lane_body.js` /
`dims.js` / `view_model.js` on the UI side; `AudioEngine::setLoopPoints`,
`setSegments`, `attachMapEditRiders`, the Q13 definer paths, `seekTransport`,
`StackNode::childContext` / period math, `ClipNode` playback + commit
snapping, and the mock twin on the engine side. Trigger: the 2026-08-29
field video (Mac) and the Windows report — "dragging the left bracket to
the right moved the whole loop region to a different part of the take
and changed its size" on a five-mic drum group.

Method: two independent read-throughs (engine, UI) with file:line
evidence, then every candidate mechanism was either reproduced by a
render-level test (`tests/content_frame_tests.cc`, which decodes WHICH
buffer sample is audible from a ramp recording) or demoted to a RISK
with a verification recipe. Fixed items are marked ✅ and pinned by a
test; the rest are listed with the recommended fix so they can be
scheduled.

## 0. The one-paragraph diagnosis

The engine has **two time frames**. A clip reads its buffer anchored on
the monotonic clock: `heard = (t − origin) mod D` (`clip_node.cc`
playback equation). A stack's window selects **epoch-relative view
positions** of its cycle: `t_child = epoch + mapOffset(t − epoch)`
(`stack_node.cc childContext`, the 2026-07-09 "view positions" ruling).
Composed, a windowed group's member hears
`(epoch − origin) + start + phase`. The two frames agree only while
`epoch ≡ origin (mod D)`. **Every gesture that moved the epoch on its own
broke that** — and the loop-region bugs found today are all instances:

| Gesture that moved the epoch alone | Audible effect |
|---|---|
| Q13 definer-stack re-trim (solved `epoch` only, 2026-08-21 form) | the trimmed loop jumped by `start` on every release, compounding — the field symptom |
| transport seek (`epoch := t − pos`) | plain clips did **not** move (cursor teleported, audio didn't); windowed groups re-selected content |
| map-edit riders (whole-Q epoch rides) | neutral for clips; re-selected content in any windowed group whose inner cycle is not a multiple of Q (the post-lock definer stack, D raw) |

The fix is one law, applied three times: **content-selecting frames move
together.** A definer re-trim re-anchors every member's origin with the
epoch (the sole-clip path's math, made fractal); a seek carries every
origin by the epoch delta; the epoch riders move only in steps that keep
every windowed group's view (`epochViewStep`). Pinned by
`content_frame_tests.cc` (render-level) and the five-mic test in
`qtime_lock_tests.cc`.

A second, independent Windows-only mechanism was found for "the five mics
stopped being one take" (§2.3), and a UI race that makes every release
snap back for a tick on a slow bridge (§3.1).

## 1. Fixed today (engine)

### 1.1 ✅ Definer-stack re-trim re-selected content (HIGH — the field symptom)
`audio_engine.cc setLoopPoints`, stack-definer branch. Solved
`e.iepoch = t0 − (pT − start)` from the model `pos(t) = start + ((t − epoch)
mod len)`, which assumes the members read epoch-relative; they read
origin-relative, so the heard region was `[2·start, …)`, drifting per
release. Proven by `content_frame_tests` "Definer stack re-trim": before
the fix 40000/40000 rendered samples disagreed with the brackets.
**Fix:** `Edit::origins` riders re-anchor every member to
`origin' = t0 − (pT − start)`, `epoch := origin'`; the sounding sample
`p0` is read through the actual playback equation (old map, origin) —
not the window's own coordinates. Undo restores origins with the epoch.
Mock twin: `mock/maps.js`. The 2026-08-21 doc line "no origin re-anchor"
was the bug; `design_language.md` Q13 bullet updated.

### 1.2 ✅ Seek moved the cursor, not the audio (HIGH, ruler scrub 2026-08-27)
`seekTransport` re-based the epoch only. A plain clip's playback ignores
the epoch, so after a seek the cursor showed the new phase while the
audio continued unchanged — `content_frame_tests` "Seek moves the AUDIO":
100% of samples wrong before the fix. The existing `seek_tests.cc` only
checked the published phase. **Fix:** every clip origin rides the epoch
delta (placement on the grid, `origin − epoch`, is invariant; the phase
jumps). Windowed groups keep their content selection (third test). Mock
twin: `mock/transport.js`.

### 1.3 ✅ Epoch riders re-tiled windowed groups (MEDIUM)
`attachMapEditRiders` moved the epoch by whole Qs under the claim
"nothing audible changes: origins are absolute" — true for clips, false
for a windowed stack. **Fix:** `AudioEngine::epochViewStep(Q)` =
lcm(Q, inner cycle of every stack with an active map); both rider
branches step by it. Mock twin `epochViewStep` in `mock/maps.js`.

### 1.4 ✅ Group arm was not one moment (MEDIUM, Windows-leaning)
`startRecordingInNode` reserved each mic's take buffer (a 4 GB virtual
reservation, `kMaxTakeSamples`) **and** published its Armed state in the
same per-mic loop. macOS reserves lazily (µs); Windows commits eagerly,
so five reservations can span audio blocks and the mics arm in different
blocks → different first-take origins → `definerStack()` returns null →
the group silently leaves the trim view for the heard view (brackets in
collapsed coordinates, fractional trims refused: "jumping all over").
**Fix:** `ClipNode::prepareRecording` (reserve) for all targets, then
`publishArm` back-to-back. (Also worth knowing: five eager 4 GB commits
is a 20 GB commit charge on Windows — see §4.6.)

### 1.5 ✅ Smaller engine fixes
- Sole-clip Q13 phase read the loop atomics, not the active map: healing
  a multi-segment definer to one window computed the phase from a stale
  window (now `activeTimeMap()` + the playback equation).
- Redo of a first take dropped every sequence (`reinstallSequenceRiders`
  was only called on Insert).
- A non-definer stack window past the inner cycle was stored verbatim
  and its unclamped length judged by the coherence guard; now refused
  like `setSegments` refuses (the definer branch clamps, matching its UI).
- Nested stacks carrying stale island (Q, epoch) after Combine and the
  members' commit-time windows under a definer stack — both from the
  morning session (`scrubNestedIslandFacts`, `liftGroupWindow`).

## 2. Fixed today (UI)

### 2.1 ✅ Release snap-back race
`window_edit.js` fired `onSetWindow` and immediately set `o._key = ''`; a
state poll in flight at release still carried the OLD window and rebuilt
the brackets there for a tick (invisible on Mac's near-synchronous
bridge, visible on WebView2). The overlay is now HELD (`body._winHold`)
until the bridge answers (capped at 1.5 s).

### 2.2 ✅ Lost pointer capture latched the overlay forever
No `lostpointercapture` / `blur` handling: a dropped capture (WebView2
on focus loss, Alt-Tab) left `body._winDrag` true and, for grip/band
gestures, the global frame pin set — the overlay never rebuilt and the
stale closure kept answering. `sv_util.guardGesture` now ends any
gesture on capture loss / blur; `runExpandedDrag` and the band drag are
idempotent on double end.

### 2.3 ✅ Smaller UI fixes
- `.lane-body` gets `user-select: none` (a drag could become a text
  selection; `preventDefault` on pointerdown does not stop that).
- The overlay key now includes `vm.quantum`, `intrinsicQ`, `isQDefiner`
  (the drag closure converts with them).
- `previewSnap` no longer deletes the enclosing map's dims.
- A second pointer on the other bracket mid-drag is ignored.
- A step audition's DERIVED window is drawn but not draggable (a drag
  wrote it back as the AUTHORED window, returning unchanged when the
  audition ended).
- Definer composite raw mode / dims tiling / members' common window
  (morning session).

## 3. Open RISKs (verified mechanisms, not yet fixed)

### 3.1 "RE-OPEN ⟹ UNCOLLAPSE" fires on ordinary takes (MEDIUM)
`applyEditImpl` Remove uses `write_position > duration` as proof of a
lock-collapse, but a snapped take normally overshoots by up to a block
(`finishCaptureBlock` writes the whole block, then commits at the
target). Deleting down to one ordinary clip sets
`duration := write_position` (off-grid by < 1 block) with the old `[0,
D)` as a window; `takeArmed` then LCMs the off-grid extent. Self-heals at
the next arm via CollapseTake, but Q13's "no incommensurate buffer
survives" is violated in between. *Verify:* record A, B; delete B; dump
A's `duration` vs `recorded`. *Fix:* track the collapse explicitly
(`content_base_ > 0` or a flag), never by overshoot.

### 3.2 Q and epoch are two atomics read separately on the audio thread (LOW)
`setQuantum` stores Q then epoch; the callback reads `islandEpoch()` and
`getQuantum()` at different points. A re-trim between the reads gives one
block a mixed pair (and the new origin riders add a third field). One
block of misplacement at worst; a packed 128-bit pair or a generation
counter would close it.

### 3.3 Group stop is per-clip on the audio thread (LOW)
`stop_requested_` is consumed at each clip's own block top; if a Q
boundary falls inside the straddled block, `nextStopBoundary` differs per
mic → different durations → not one take. Same shape as §1.4 (arm), not
fixed: the stop path has no allocation, so the window is nanoseconds; a
per-group generation the audio thread consumes at one block top would
make both exact.

### 3.4 Windows DPI and `warpPointer` (LOW, heard-view grips only)
`map_bands.js` warps in CSS px; `main_component.cc` treats them as JUCE
points. At 125/150 % scaling the cursor lands off the handle and the
resulting sub-150 px "echo" is applied as a real delta (`|dx| < 150`
inside 400 ms). *Verify:* `window.__mapDbg` entries with a large first
`render` delta right after `warp {ok:true}` on a scaled display.

### 3.5 No lock-collapse for a group definer (DEBT with audible edge)
The sole-clip definer collapses at the second arm so no incommensurate
buffer survives. The definer STACK keeps its raw D as the inner cycle;
§1.3's `epochViewStep` now protects it from the riders, and
`takeCommitted`'s re-base is already a multiple of it, but the raw D
still inflates `lcm_before_take_` and the Q15 origin fold. The fractal
answer is a group collapse (splice every member to the window, stack
window consumed) with the group twin of RE-OPEN ⟹ UNCOLLAPSE.

### 3.6 Window riders skip members with multi-segment overrides
A member of a definer stack with its own segment map keeps looping it
under the stack window; the trim view lies for it. Rare (needs a
pre-lift state plus a segment edit on a member).

## 4. Tech debt / over-complication (ranked by leverage)

### 4.1 One playback equation, restated by hand in six places
The phase-preserving solvers (`setLoopPoints` clip branch, stack branch,
`setSegments`, `attachMapEditRiders`/`continuityOrigin`, and the mock's
twins) each re-derive "which sample sounds now" from their own idea of
the frame — §1.1 and the healed-override bug were both restatements that
drifted. **Proposal:** one engine function
`heardBufferIndex(node, t)` that composes the real `childContext` + clip
equation (it exists implicitly in the audio path), used by every solver
and by a golden test. The mock imports the same math from
`time_map.js`.

### 4.2 Definer detection lives in three places with two definitions
`AudioEngine::definerStack` (origin + duration), `view_model.definerStackOf`
(same) **and** `view_model.oneTakeDuration` (duration only — used for the
composite extent and `intrinsicPeriod`), plus `mock/state.js`. A
one-sample disagreement between them flips the lane between the trim
view and the heard view (§1.4 made this reachable). **Proposal:** the
engine publishes `definerId` in the state; the VM reads it, never
re-derives.

### 4.3 "Window active" and "period" have ~7 copies each
Window activity: `AudioNode::isLoopWindowActive`, the StackNode override,
`activeTimeMap().active()`, VM `windowOf`/`memberCommonWindow`/
`nodeMapPeriod`, `timeline_model.stackEffectivePeriod`, the mock.
Period/cycle: `getEffectivePeriod`, `snapEffectivePeriod`,
`periodExcluding` (which ignores the sequence period law — a real
divergence), `calculateEffectiveCycleLength`, `childContext`'s fold, VM
`computeCycleSamples`, mock `effectivePeriodOf`. The mock's
`stackInnerCycle` folded EFFECTIVE periods until today (the engine folds
intrinsic); it clamped definer trims to a member window's length.
**Proposal:** build the snapshot on the message thread and route
`periodExcluding` / `calculateEffectiveCycleLength` through
`snapEffectivePeriod`; on the UI, one `time_map.js` predicate set
imported by VM, timeline_model, map_bands and the mock.

### 4.4 Gesture code is four hand-rolled copies
`window_edit.js` brackets, `map_bands.js` trim grips, seam handles and
cut bands each implement capture / ghost / preview / commit / end. §2.2
had to be patched in three places. **Proposal:** one gesture runner
(`startGesture({node, onMove, onEnd})`) owning capture, the guard, the
hold-until-settled commit, `_winDrag` and the frame pin — the only place
those latches are set or cleared.

### 4.5 State kept on DOM nodes
`body._winDrag/_winHold/_layers/_bandState/_bandsWired/_flashT`,
`div._peaksRef/_dk/_liveBoost/_exiting`, `container._key`,
`winCursor._pos/_phase`, `band._lastLive`, `row._lane`. Each is a latch
with its own failure mode (§2.2 was one). A per-lane view-state object
keyed by lane id would make "what is frozen and why" inspectable and
would survive node replacement.

### 4.6 The 4 GB per-clip reservation (D4) assumes lazy overcommit
`kMaxTakeSamples = 2^30` × channels × float = 4 GB virtual per armed
clip, "deliberately not cleared". On Windows `malloc` commits, so a
five-mic arm is a 20 GB commit charge, slow (§1.4) and at the mercy of
the pagefile. **Proposal:** reserve with `VirtualAlloc(MEM_RESERVE)` /
`mmap(PROT_NONE)` and commit in chunks from the audio-thread-safe
growth path, or cap the reservation at a session-configurable length
(minutes, not 6 hours) with the existing "reservation bound" commit.

### 4.7 Function size and stale comments
`patchLaneBody` 340 lines, `deriveViewModel` 230, `pushGroupLane` 170,
`setLoopPoints` ~250 with three definer paths inline. Stale comments
found: `map_bands.js:9-11` (says ⌥ is gone; two ⌥ modes exist),
`view_model.js` TODO above `childSrcSegsUnderMap` (implemented),
`lane_body.js` "four branches" with #4 implicit, `window_edit.js` header
citing §2 (law 13), and — now removed — the design-language line "no
origin re-anchor" that described §1.1.

### 4.8 Duplicated constants and near-dead branches
Two "minimum length" constants (`Q_DEFINER_MIN_LEN_Q`, `MIN_CUT_Q`);
`window_edit.js`'s multi-segment early return duplicates the
`lane_body.js` branch that never reaches it; `Q13 setSegments` has no
stack-definer twin (a multi-segment map on the definer stack is refused
by the coherence guard while a single window is accepted).

## 5. What to watch for in the field

- After a definer trim, the composite should NOT change shape, the loop
  should NOT jump, and undo should return exactly the previous window
  and its sound.
- Ruler seek: the audio must jump with the cursor now. If anything
  sounds like it did before (cursor moves, music doesn't), that is §1.2
  regressed.
- Five-mic group takes: `dumpState` and check every member's `origin`
  and `duration` are identical; if not, §1.4/§3.3 — send the dump.
- A release that briefly snaps a bracket back then forward is §2.1
  regressed (or a hold longer than 1.5 s: bridge latency).

## 6. Tests added / changed
- `tests/content_frame_tests.cc` (new): render-level "which sample is
  heard" for the definer re-trim (two edits + undo), plain-clip seek and
  windowed-group seek.
- `tests/qtime_lock_tests.cc`: NESTED FACTS (combine → stale Q chain),
  windowed-members riders, FIVE MICS repeated left-edge trims.
- `ui/js/tests/q13.test.mjs`: members' common window; origins ride the
  epoch. `composite_waveform.test.mjs`: raw mode, stable cache key.
- `ui/e2e/session_view.spec.js`: dims match brackets on a fractional
  frame; composite does not redraw on a re-trim.

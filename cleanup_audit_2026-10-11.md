# Celestrian cleanup audit — 2026-10-11

Audited at `0910949` (clean tree). Five lenses, as asked: logic to share,
things to split, test code to shed without losing coverage (plus missing
coverage), bugs and logic holes, and documentation that is missing, wrong or
costing more reading than it gives.

## Summary

The kernel maths is in good shape: the timing, time-map and rational-time
layers match their JS mirrors function for function, the audio callback is
clean against the real-time contract, and coverage is high (91% of `src/`
lines, 92% of UI lines). The debt is at the edges of that core, and it is
concentrated.

**Bugs.** Nine reproduced, twelve more confirmed by reading, about sixty
reported and not re-checked (§2). The ones that matter most:

- Dragging a group onto one of its own members deletes the whole group from the
  session; dragging a member onto its own group and pressing undo crashes (E1).
- Undo or Escape after a live loop-region drag can leave the clip shifted by
  whole Qs against every other track (E3).
- Live MIDI is duplicated or dropped whenever a step boundary, gate corner or
  window seam cuts the block (E4).
- After a sample-rate change, the next fx toggle reallocates an effect's
  buffers under the running audio thread (E6).
- A take committed within 3 seconds of quitting or switching project is not
  saved (E10).
- On Windows, a new take of a slot longer than about 65 s, or any take on an
  island whose Q is longer than about 60 s, crashes or is force-stopped (E8, E9).
- In the app, every native file dialog reports "cancelled" after one second
  while it is still open (U7).
- A clip's cut map, once bypassed, cannot be switched back on from the lane (U1).

**Tests.** The C++ suite takes 390 s; three one-line changes bring it to 43 s
(measured). About 9,900 of 49,400 test lines (20%) can go with no behaviour
unpinned, for a measured coverage cost of a handful of lines; another 3,500 if
you accept thinner pins (§5.3). The largest sources are two whole C++ files
that restate the golden vectors and the scenarios, and a test harness that
every file rebuilds. About twenty tests or groups of tests cannot fail (§5.4). The gaps that matter
are a generic undo-round-trip check, MIDI takes past the first, and any real
drag against the real engine (§5.5).

**Shared logic and splits.** About 2,000 lines of logic are stated more than
once (§3); the duplications that have already produced bugs are the stack's
per-run context, the two map-edit verbs, and the UI's seven ways of reading a
node's map. Fifteen things are worth splitting (§4); `applyEditImpl` (an
812-line switch), `view_model.js` and `app.js` first.

**Documentation.** About a fifth of the 15,700 comment lines in non-test code
can go without losing a law, because each law is told at every consumer and
often with its history (§6). Roughly 115 comments contradict the code under
them, and several of those caused or hid a bug above. A handful of places
need a comment they do not have, and each would have prevented one.

§8 is an order of work; §9 lists nine questions that need your ruling.

## 1. How this was done, and how far to trust each claim

**Measured (ran today, everything green at HEAD).** All in a scratch copy of
the tree; the repository was not touched.

| Layer | Size | Result | Coverage |
|---|---|---|---|
| C++ unit (`CelestrianTests`) | 490 cases, 24.6k lines | all pass | 90.9% of `src/` lines (8,523 / 9,378 instrumented) |
| JS unit (`ui/js/tests`) | 79 files, 15.1k lines | all pass, 18 s | 53.7% of UI code lines alone |
| Mock-page e2e (`ui/e2e`) | 155 cases, 6.7k lines | all pass, 36 s | 86.6% of UI code lines alone; **92.1% with unit** |
| Engine e2e (`ui/e2e_engine`) | 13 specs, 2.0k lines | not run (needs a fresh `CelestrianHeadless`) | not measured |

The C++ numbers come from a source-coverage build that dumps one profile per
`beginTest`, so every one of the 490 cases has its own line set. The JS numbers
come from V8 block coverage per test file and, for Playwright, per case.

**Reviewed.** Seventeen reviewers, one slice each (ten source slices, seven
test slices), each reading its slice in full. Their bug claims are graded here
by what I did with them:

- **Reproduced** — I ran it: a test compiled against the real engine, a probe
  through the real `deriveViewModel`, or real input in the mock page.
- **Confirmed by reading** — I opened the cited lines myself and the trace
  holds; not executed (most are races, Windows-only, or need hardware).
- **Reported** — a reviewer traced it and I have not re-checked it. Treat as a
  strong lead, not a fact.

Items the 2026-09-03 kernel audit already lists are tagged `known: D…` and not
re-argued.

## 2. Bugs and logic holes

### 2.1 Engine — reproduced

| # | Sev | Where | What happens | Fix |
|---|---|---|---|---|
| E1 | high | `src/engine/edit_log.cc:529-575` (Combine), `:576-612` (Explode); reachable from `ui/js/session_view/lane_build.js:95-103` (rail drop) and the selection bar's Group (`ui/js/app.js:617-621`) | **Combine has no ancestor/descendant guard** (Move has one at `:511-517`). Drag a group's rail onto one of its own members: the group is detached, the new stack is inserted *into* the detached group, and the whole group silently leaves the session — 3 nodes reachable from the root before, 0 after, and the verb returns a stack id as if it worked. The other direction (member onto its own group) succeeds, and **undo then segfaults** (`Explode` detaches both children before resolving the parent, which is one of them). | Refuse in Combine when either node is an ancestor of the other (the Move loop, both directions); in Explode resolve both parents before detaching anything. Mirror the refusal in `ui/js/mock/graph_crud.js:157`. ~10 lines + two tests. |
| E2 | med | `src/engine/edit_log.cc:587-610` | **Undo of a group restores the wrong sibling order** when a sibling sat between the two tracks. Root `[T, X, D]`, group D with T, undo → `[T, D, X]`. Explode reinserts at the original indices while the emptied stack is still in the parent. Every later index-addressed inverse on that parent then lands one off. | Detach the stack first, then reinsert. Same edit as E1. |
| E3 | high | `src/engine/edit_log.cc:1331-1338`; `src/engine/island_geometry.cc:405-413`, `:457-463` | **A coalesced gesture keeps only its first inverse**, and that inverse carries an origin rider only if the first commit happened to move the origin. Repro: 1Q definer + 8Q clip, playing 5.5Q into the clip; `setLoopPoints(B, 0, 4Q)` (origin stays), then a live `setLoopPoints(B, 0, 7Q)` (origin moves −2Q), then undo → the window is restored but the clip stays 2Q early against every other track. Cancel (`Escape`) takes the same path. | In the coalesce branch, fold into the kept entry whatever riders it lacks (`setsOrigin/iorg`, `setsIsland`, `restoresBypass`, window riders) — ~15 lines — or have the map appliers always capture the origin. |

The repro test is `tests/audit_repro_tests.cc` in the scratch build (four cases;
it is 130 lines and would drop into `tests/` as the regression tests for the
fixes).

### 2.2 Engine — confirmed by reading

| # | Sev | Where | What happens | Fix |
|---|---|---|---|---|
| E4 | high | `src/stack_node.h:519-524`; consumers `src/dsp/vst3_slot.cc:65-66`, `src/clip_node.cc:1055-1059` | **Live MIDI is handed whole-block to every seam run.** `forEachSeamRun` re-bases `master_pos`, `island_pos`, `num_samples` and `input_clock` for each sub-run but copies `live_midi` as is. The plugin path then takes events `[0, run)` unshifted: an event at block offset *p* reaches every run longer than *p* and no run otherwise — early notes are doubled, late ones (including note-offs) are dropped. Happens in any block that a step boundary, gate corner, window seam or one-shot boundary of the armed node or an ancestor cuts. No test drives live MIDI through a splitting stack. | Slice per run: fill a preallocated per-stack `MidiBuffer` with `addEvents(*live_midi, done, run, -done)`. ~8 lines. |
| E5 | med | `src/stack_node.h:519-524`; `src/stack_node.cc:537-539` | Same sub-context copy: **a parent's gate ramp `(g0, g1)` is replayed in full on each sub-run of a child stack** — the envelope becomes a sawtooth that jumps back to `g0` at the child's seam. Q-aligned seams hide it; free step lengths and long fades expose it. | Interpolate `g0/g1` per sub-run (3 lines). |
| E6 | high | `src/dsp/fx_chain.h:49-57`; `src/dsp/effects.cc:169-176`, `:221-229`; `src/engine/device_service.cc:348-375`; `src/engine/verbs.cc:164-176`, `:318`, `:338` | **Effects are re-prepared on a live chain after a sample-rate change.** `audioDeviceAboutToStart` only caches the new rate. The re-prepare happens later, lazily, from `setSlotEnabled` / opening an fx panel / MIDI-arm, with audio running: `FxEcho::prepare` reallocates the delay line `process` is indexing. Until then enabled effects also run at the old rate (echo time, EQ corners off by the ratio). Found independently by two reviewers. | Sweep every node's chain in `audioDeviceAboutToStart` (no callback in flight there). ~10 lines. |
| E7 | high | `src/clip_node.cc:1503` vs `:1589`, `:1620`, `:1637`; `src/engine/take_service.cc:638-653`, `:694` | **`reconcileTakes` can read a commit half-done.** The audio thread stores `rec_state_ = Idle` first and `duration_samples` ~85 lines later in the same call. A reconcile between the two sees "settled, nothing committed", erases the pending entry and moves on; the take then finishes committing with no undo entry and no settle (for a new take of a slot, `settleRetake` never runs and the previous take is overwritten at the next stash). A microsecond window per commit against a reconcile on every poll and most verbs. Root cause is `known: D4-9`. | Slice-local: return from `reconcileTakes` while `root_node->hasActiveTake()`; treat a new-take member as unsettled until `retakeSettled()`. Durable: store Idle last. |
| E8 | high (Windows) | `src/take_storage.cc:38`, `:58`; `src/clip_node.cc:1401`, `:1423-1429`, `:1966-1974` | **Clears past the committed edge of a take reservation.** On Windows the reservation is `MEM_RESERVE` and the arm commits 2.88 M samples (rounds to 3,145,728 = 65.5 s at 48 kHz, 32.8 s at 96 kHz). A through-map arm then clears `[0, C)` and a new take clears `[0, max(base + period, collapsed_from))` with no `commitTo` first. Any map cycle or slot period longer than that writes uncommitted pages: access violation. macOS is lazily backed, so nothing here can show it. | One "furthest sample this take may touch" value; `commitTo` it before each clear and have the grower use it. ~15 lines. |
| E9 | high (Windows) | `src/clip_node.cc:185-199`; `src/clip_node.h:263`; `src/engine/take_service.cc:100` | **The wall guard needs `Q + 8192` of committed headroom; the grower keeps a fixed 2.88 M samples.** On any island with Q ≳ 60 s at 48 kHz (30 s at 96 kHz) every take trips `cap_hit_` and is force-stopped at the first boundary. | Make the headroom `max(kArmCommitSamples, Q + margin)`. |
| E10 | med | `src/main_component.cc:241-245`, `:223`, `:398-408`; `src/project_manager.cc:117-135` | **Nothing flushes the project mirror on quit or project switch.** The mirror is written only by the 3 s timer. Record, stop, quit (or open another project) inside 3 s: the take's WAV is never written; if it was the first take the project is never born. | `ProjectManager::flush()` from `~MainComponent` and at the top of `openProject` / `newFromTemplate`. ~8 lines. |
| E11 | low-med | `src/project_manager.cc:158-169` vs `:181-183` | `saveAsTemplate` uses the raw display name as a folder path. "Rock/Metal" saves into a subfolder the lister never shows; `..` writes into the base folder. Track templates already sanitise. | `createLegalFileName(name)`. |
| E12 | low | `src/session_io.cc:194-199` | `readClipWav` passes a possibly-null stream to JUCE's WAV reader, which dereferences it (`juce_WavAudioFormat.cpp:1229`). A WAV that exists but cannot be opened crashes the load. | Null check. |
| E13 | med (likely) | `src/clip_node.cc:212-213`, `:276`, `:321-328`, `:1494-1496` | **An audio take with no input source never advances.** Both capture paths require a ring or input channels; with Q > 0 a stop parks the clip in `PendingStop` at a boundary the write head never reaches, the island stays "take live", and every edit and arm is refused until a device with inputs appears. | Drive the take by the clock over silence, or refuse to arm without inputs. |

### 2.3 Engine — reported, not re-checked

| Sev | Where | Claim |
|---|---|---|
| med | `src/clip_node.h:329-373`, `:392-442`; `src/clip_node.cc:826-838` | The comp is not re-expressed by a collapse or splice (cells keep indexing the pre-collapse base), and `compCellLength()` is never published, so the UI can draw a cell grid the engine does not play after a Q change. |
| med | `src/engine/take_service.cc:183-203`, `:223`, `:257` | `startRecordingInNode` mutates before it refuses: a refused arm leaves the transport running, the definer lock-collapsed (an undo step) and a Q hand-off ended. Three reviewers reported this independently. |
| med | `src/engine/edit_log.cc:492-500` vs `:287-295` | Remove's re-open of a collapsed survivor overwrites geometry authored after the lock; the Definer re-open has the guard, Remove does not; undo does not bring it back. |
| med | `src/engine/edit_log.cc:710-746` vs `:304` | The arm-time lock-collapse splices a *bypassed* multi-segment map; a bypassed single window is left alone. Two answers to one state. |
| med | `src/heard_index.h:114-119`, `:48-51` vs `src/stack_node.cc:160-162` | `heard::` still computes a one-shot stack's shot from the intrinsic duration; the audio thread uses the own period. Region edits inside such a group solve against a clock the render does not use. |
| med | `src/stack_node.cc:467-470`, `:545-551` | A one-shot group's rest skips its children's render entirely, so member reverb/echo tails freeze and live monitoring goes dead for the rest — the opposite of the mute rule in `audio_node.h:699-704`. `content_silent` already exists for this. |
| med | `src/plugin_editor_windows.h:19-42`; `src/engine/edit_log.cc:1106-1122`, `:1243-1245` | A plugin editor window can outlive its instance: add plugin → open editor → undo → any new edit retires the slot with the window still open. |
| med | `src/engine/take_service.cc:199-203`; `src/engine/edit_log.cc:367-368` | `collapseDefinerAtArm`'s `exclude` is dead for a clip and skips the collapse when the definer *stack* is the arm target — same arm set, two outcomes depending on which button was pressed. |
| low-med | `src/session_io.cc:569-574`, `:614` | Loading a bundle whose root has no `effects` leaves the previous session's master rack on the live root. |
| low-med | `src/session_io.cc:87-122`, `:150` | A failed take-WAV write is silent and still clears `takeFilesDirty`, so later incremental saves skip it. |
| low | `src/engine/verbs.cc:113-131` | `combineNodes` bypasses `record()`: no island-wide live-take gate (the mock has one). |
| low | `src/engine/import.cc:171-175`, `:266-276` | Import onto a stack logs two undo entries; `docs/import.md` and the mock say one. |
| low | `src/engine/device_service.cc:281`, `:309-314` | A failed re-calibration discards the working calibration until restart. |
| low | `src/engine/take_service.cc:553-565` | `setComp`'s cell bound also refuses a clear. |
| low | `src/engine/island_geometry.cc:631-642` | Sequence rescale on a Q change is not reversible for free-length steps and fades (`llround` both ways). |
| low | `src/clip_node.cc:694-715` | Live-tail monitoring: mute and solo-loss are hard cuts; the comment promises a fade. |
| low | `src/clip_node.cc:1369`, `:1458-1471` | `content_kind_` sticks at Midi after a cancelled arm. |
| low | `src/clip_node.cc:255-258`, `:292-295` vs `:751-754` | Input −1 or out of range: capture clamps to a real channel, monitoring is silent. |
| low | `src/audio_node.h:839-842`, `:868-870` | `anchored_` flips at once while the origin it selects is adopted at the next block top. |
| low | `src/stack_node.cc:599-606` | A group's output channels ≥ 3 are fed from the accumulator's right channel; the comment and the clip say channel 0. |
| low | `src/dsp/fx_chain.cc:153-176` | `FxChain`'s promotion scratch is never sized on a successor chain, then sized on a live one (mono devices only). |
| low | `src/dsp/vst3_slot.cc:26-54` | `Vst3Slot::doPrepare` never checks the stereo layout was accepted. |
| low | `src/engine/import.cc:57-60` vs `:91-97` | Import checks the take ceiling before resampling only. |
| low | `src/main_component.cc:80-89` | The app shell's `loadSession(path)` override is a raw engine load, bypassing `ProjectManager` (latent: the UI only sends `''`). |

### 2.4 UI — reproduced

| # | Sev | Where | What happens | Fix |
|---|---|---|---|---|
| U1 | high | `ui/js/session_view/window_edit.js:72` (guard) before `:78-86` (chip wiring) | **A clip's multi-segment map, once bypassed, cannot be re-activated from the lane.** `wireWindow` returns on `segs.length > 1` before it gives the chip its `toggle` class and listener. In the mock page: make a cut on a clip, bypass it — the chip changes from "map 2Q" (`pointer-events: auto`) to "window · bypassed" (`pointer-events: none`). Only ⌘Z gets back. The comment says multi-segment maps "never reach here"; clips do. | Wire the chip before the guard. ~6 lines moved + one e2e. |
| U2 | low | `ui/js/session_view/selection.js:108-113`, `:141-151` | **⌘-click on the only selected rail jumps the selection to the first lane.** The additive branch empties the set without setting `userCleared`, so the next patch re-selects lane 1. Reproduced with real clicks. `toggleSelect` has no test. | Refuse to remove the last member (the header's stated law). 2 lines. |
| U3 | med | `ui/js/view_model.js:649-652` | **Fade ramps index per-step lengths by visit index** (`runLen += stepsQ[k]`, should be `stepsQ[visits[k]]`). Identical for a plain loop; wrong for any successor program, `NaN` when visits outnumber steps. Probe: expected `[4.5, 5]`, got `[2.5, 3]`. | 1 line; better, hand the function one visit-indexed array. |
| U4 | med | `ui/js/view_model.js:2068-2102` (`childSrcSegsUnderMap`, exit at `:2090`) | **A member's slice under a parent map is cut short by float noise** at a period boundary: the walk runs in Q floats and `break`s on a sliver. With an off-grid group window, 497 of 4,768 member lanes (10%) come back short at Q = 44100. | Do the walk in integer samples with `time_map.js innerAt` (golden-pinned); −15 lines. |
| U5 | low | `ui/js/view_model.js:151`, `:226` | A single window's period in Q is the difference of two divisions. An exactly-4Q window with an off-grid start yields `3.9999999999999996`, and `unrollReps` emits a zero-width second tile. The multi-segment branch does it correctly. | `periodQ: nodeMapPeriod(node) / quantum`; an `EPS` in `unrollReps`. |
| U6 | med | `ui/js/view_model.js:1030-1041`, `:1004-1009`; `ui/js/timeline_model.js:404-420`, `:229-252`, `:305-333` | **The frame is computed by a second, older period law**, not the golden-pinned `islandCycle`. Feeding the 15 Q-established golden fixtures through `deriveViewModel`: 14 agree; "a window over a song stays exempt" gives golden 13000, frame 5000. Needs a Q hand-off to arise. `known: D2-1` residue. | `cycleSamples = islandCycle(...)` with the VM's providers; delete `stackEffectivePeriod`, `commensuratePeriod`, `clipCycleContribution` (~150 lines). |

### 2.5 UI — confirmed by reading

| # | Sev | Where | What happens | Fix |
|---|---|---|---|---|
| U7 | med-high | `ui/js/bridge.js:58-103`, `:116-135` | **The production bridge is the event path, and its 1 s timeout fires under every native dialog.** `callNative` first tries `window.__JUCE__.backend[name]`, "the path that runs in production". JUCE 8.0.4's injected `Backend` has only `addEventListener / removeEventListener / emitEvent / emitByBackend` (`juce_WebBrowserComponent.cpp:135-160`), so every call takes the event path, which resolves `null` after 1000 ms. The chooser verbs complete only when the dialog closes (`main_component.cc:299-314`), so one second after it opens the page reads "Open cancelled" / "Bounce cancelled" / "Import cancelled" and runs its follow-ups early; an imported track is never auto-selected. Any verb that holds the message thread over 1 s fails the same way. The one bridge unit test stubs the direct path production never takes. | Make the event path the only path, register the completion listener at module load, drop the timeout (or keep it for the two heartbeat polls). −35 / +12 lines. |
| U8 | med | `ui/js/session_view/patch.js:40`, `:192`; `ui/js/session_view/ruler_seek.js:48-54`; `src/engine/transport.cc:44` | **The ruler is not locked while a take is armed.** It locks on `lane.recording` only; the engine refuses a seek when armed *or* recording. With a track armed and pending, the ruler shows the scrub cue and the gesture silently does nothing. `vm.mapEditsLocked` is already the engine's condition. | `noteSeekVm(vm, !!vm.mapEditsLocked)`. 1 line. |

### 2.6 UI — reported, not re-checked

| Sev | Where | Claim |
|---|---|---|
| med | `ui/js/view_model.js:898-908` | The trim view reads the definer's selection from raw `loopStart/loopEnd`; a multi-segment definer gets the whole take and a cursor at the wrong sample. |
| med | `ui/js/session_view/map_bands.js:350-415` | Raw cut-band drag: a cancel leaves the band drawn where it was dropped (overlay key never invalidated); no engage gate, so a 1 px click moves the cut off-grid and logs an undo step. It re-implements `runRawDrag` and omits what was added later. |
| med | `ui/js/session_view/lane_body.js:663`, `:678-717` | A multi-segment group map suspended by its sequence draws as an active map; the "suspended" wording sits in a branch that cannot show it. |
| med | `ui/js/app.js:758-769`, `:1098-1104`, `:984-1005` | Three unguarded DOM writes on clickable chrome. The Calibrate button's text node is replaced every 50 ms poll — the case the project's own WebKit click law names. |
| med | `ui/js/app.js:309-336` | A retaking lane fires `getTakeWaveform` on every patch (~20 bridge calls/s per clip) and can never fill its cache, because both backends answer `[]` for a non-idle clip and empty answers are not cached. |
| med | `ui/js/keys.js:158-170` | Hotkeys fire on keyboard auto-repeat: a held Space or R toggles repeatedly. |
| low | `ui/js/app.js:1287-1297` | The "second Space pauses at once" branch cannot pause (the engine refuses) and cancels the pause the first Space queued. |
| low | `ui/js/app.js:1091-1109` | Opening an existing project from a fresh launch announces "Project … created" and migrates the scratch session's fold ids into it. |
| low | `ui/js/app.js:1226` | "Template saved — it loads automatically next launch" is false (Q17: no auto-load). |
| low | `ui/js/session_view/seq_grid.js` | Five in one file: the fades popover closes itself one poll after its first field commits (`:674-681`); frame-health "snap to NQ" can be a dead button that still spends an undo step (`:427-434`); pad painting has no release safety net (`:345-364`); the resize grip strips fade markers on a no-op drag (`:811`); the rebuild signature omits `innerCycleQ` (`:157-162`). |
| low | `ui/js/session_view/lane_body.js:495-496` | Comp-mode raw lane: gridlines stop at the shared frame's length. |
| low | `ui/js/session_view/map_core.js:707`; `region_panel.js:1022-1034` | The one-undo-step latch can be reset from outside the live gesture (a second pointer, or ← / → mid-drag). |
| low | `ui/js/session_view/region_panel.js:1028-1033` | The nudge chain's base survives an undo (→, ⌘Z, → within 800 ms lands 2Q off). |
| low | various | No button filter on six gesture sites (right-click starts a drag); bracket chip prints a raw float under ⌥ (`window_edit.js:116-118`); comp slice canvas inset twice (`comp_cells.js:19-21`); creation menu can run off the bottom of the window; per-node caches in `app.js` are never pruned; `index.html` blocks first paint on a Google Fonts request. |

### 2.7 Mock ↔ engine drift

These do not affect the shipped app; they affect how much the 15k lines of
mock-driven tests prove. The mock reviewer ran probes for each (the scripts are
in the scratchpad); I did not re-run them.

| Sev | Where | Drift |
|---|---|---|
| high | `ui/js/mock/maps.js:304-305`, `:330-340` | The clip-definer re-trim of a fresh take jumps to the window top instead of preserving phase. `q13.test.mjs:151-153` hides it by pre-writing a full-span window "real commits always leave" (no longer true). |
| high | `ui/js/mock/state.js:588-632`; `ui/js/mock/undo.js:197-229` | Whole-graph snapshots are not the engine's inverse edits: undo also reverts pan, gain, solo, monitor and fx params; a take's undo removes edits made during the take, and the next undo puts them back. |
| high | `ui/js/mock/recording.js:105-121`, `:448-479` | S21 auto-target: a nested song's position is folded on the wrong cycle, and the auto-targeted take is never auto-gated. |
| med | `ui/js/mock/recording.js:430-440`, `:495-526` | A refused through-map arm leaves the recording view frozen (`seekTransport` then answers false); a group arm is not all-or-nothing. |
| med | `ui/js/mock/undo.js:159-179` + 51 call sites | Nine refusal paths keep the dispatch's undo snapshot (a no-op undo step that kills the redo branch). `popUndoForRefusal` is hand-called at 51 sites; one check in `callNative` ("unchanged graph records nothing") replaces them all. |
| med | `ui/js/mock/recording.js:303-307`, `:560-562`, `:591-602` | Two negative-offset arm clamps the engine removed, and a private restatement of `armTarget`. |
| med | `ui/js/mock/state.js:442-448`; `ui/js/mock/recording.js:471`, `:541-542` | The root's frame top is read as the island zero in three places. |
| med | `ui/js/mock/graph_crud.js:82-88` | The re-open on delete fires for any delete, not only one that removed content. |
| med | `ui/js/mock/transport.js:94-114` | A seek does not re-frame the undo history (engine: `shiftHistoryAbsolutes`). |
| med | `ui/js/mock/import.js:97`; `ui/js/mock/maps.js:376-386`, `:595-603` | "Whole = no window" holds in the engine and only half in the mock. |
| med | `ui/js/mock/recording.js:70-123`, `:419-424` | Record does not start the transport (the engine does; `session_view.spec.js:138` works around it), and the first arm resets the clock the engine never resets. |
| low | several | Live-take gate list differs for two verbs; the published node is a spread of the raw node, so private fields leak and `effectiveQuantum` / `launchPoint` go stale; 84 test call sites take the new node id from `createNode`'s return, which the engine does not provide. |

The reviewer's proposed lever, which I agree with: stop relying on reading for
parity. One differential script that drives the same verb sequence against
`CelestrianHeadless` and the mock and diffs the published fields would have
caught nearly every row above.

## 3. Logic to share

Ordered by leverage. Line estimates are the reviewers'; I have not re-counted
them. Where a duplication has already produced one of the bugs above, the bug
id is given — those are the ones that pay twice.

| # | What is stated more than once | Where | Single home | Est. |
|---|---|---|---|---|
| S1 | A stack's per-run scope facts (active map, one-shot facts, `innerAt`, effective period) are recomputed three to five times per run, and the copies disagree in one place (`innerOf` folds on the map period, `childContext` on the context cycle). The splitter already holds the run's `InnerAt` and throws it away. | `src/stack_node.h:455-527`, `:394-400`; `src/stack_node.cc:152-175`, `:272-388`, `:455-470` | Read the facts once per phase in `forEachSeamRun`; hand each run its `InnerAt`, its gate slice and its MIDI slice. Deletes `inRest`, `innerOf`. **Fixes E4 and E5 structurally.** | −40 |
| S2 | `setLoopPoints` and `setSegments` are one verb written twice: same gate, identity check, coherence guard, three definer branches, members-whole riders. They have drifted (clamp at `:54-57` vs `:139`; two different fold rules when the cut removes the sounding sample). | `src/engine/map_edits.cc:20-222` and `:224-413` | One `commitMap(node, TimeMap, live)` (a single window is `TimeMap::single`). `known: D13-4` residue. | −150 |
| S3 | "The published node's map" is unpacked in seven places in the UI model and three more outside it, each restating "`segments.length >= 4` → pairs, else `loopStart/loopEnd`, unless bypassed", with different clamps and two different activity reads. | `ui/js/view_model.js:128-153`, `:983-993`, `:1102-1116`, `:1137`; `ui/js/timeline_model.js:238-246`, `:273-284`, `:410-415`; `ui/js/time_map.js:98-102`; `composite_waveform.js:208-214`; `session_view/pending_edits.js:152`; `app.js:1438` | `publishedMap(node)` / `publishedMapPeriod(node)` in `time_map.js`. Makes "never raw `loopStart`" checkable by grep. **U5 and the definer trim-view bug live here.** | −45 |
| S4 | The frame's period law exists twice: the golden-pinned `islandCycle`, and the older `computeCycleSamples` / `stackEffectivePeriod` / `commensuratePeriod` family that the view model actually uses. | see U6 | `islandCycle` with the VM's providers. **Fixes U6.** | −150 |
| S5 | A pointer-drag lifecycle. `beginGesture` and `runRawDrag` are real single owners used by eight gestures; the raw cut-band drag re-implements `runRawDrag` piece by piece and omits what was added later (engage gate, key poison, held preview). The re-time sender and the edge-panner block are also written twice. | `ui/js/session_view/map_bands.js:350-415`; `splice_handles.js:771-811` vs `region_panel.js:648-716` | Put the cut band on `runRawDrag` via a `bandMoveFn`; a `timingSender` in `map_core`. Closes the reported cut-band bugs. | −110 / +50 |
| S6 | Popover open / toggle / outside-dismiss / Escape: five implementations in the session view and three more in the app shell, with three different dismiss mechanisms. Escape differs per popover — the project menu, fx picker and both sequencer popovers do not answer it; the input and creation menus are closed by the view's Escape, which also clears the selection. | `session_view/creation_menu.js`, `take_menu.js`, `input_menu.js`, `fx_row.js:105-143`, `seq_grid.js:524-694`; `preferences.js:59-109`, `plugin_panel.js:27-57`, `app.js:1254-1270` | One `popover.js` owning single-open, one document `pointerdown`, one PANEL-scope Escape. | −115 |
| S7 | The sequence wire format is written three times and parsed three times (name, len, cue, next, fades, seed, gates); only the length encoding and gate keying differ. A new step field lands in four to six places — the fades already did. | `src/stack_node.cc:89-122`; `src/session_io.cc:48-78`, `:721-771`; `src/track_template.h:90-129`, `:165-214`; `src/engine/map_edits.cc:534-604` | `Sequence::toVar(encoder)` / `fromVar(decoder)` in `sequence.h`. `known: D7-4`. | −60 to −120 |
| S8 | The splice copy exists twice verbatim (the header's inline bodies cannot see the `.cc` helpers); "what a take is" is listed four times (`stripTake` / `stashLive` / `restoreTake` / `adoptSlot`); "install a content pointer" about seventeen times although `swapContent` exists. | `src/clip_node.h:394-417` ≡ `src/clip_node.cc:2011-2034`; `clip_node.h:762-781` ≡ `clip_node.cc:2037-2059`; `clip_node.h:493-564`; `clip_node.cc:1824-1850` | Move the bodies to the `.cc`; `swapContent` + a `swapMidi` twin; one `makeEmptyContent()`. | −85 |
| S9 | The output stage and gate ramp are written three times. | `src/clip_node.cc:783-816`, `:1089-1120`; `src/stack_node.cc:575-619` | `renderMidi` calls `applyGate` + `sumOutputStage`; hoist one `sumOutputStage` next to `outputStageGains`. | −28 |
| S10 | The live-take gate is stated at three layers: five verb preambles, `record()`, eleven applier checks. The one path that skips the real gate is `combineNodes`. Two of the comment paragraphs explaining it are now false. | `src/engine/map_edits.cc:37-43`, `:236-241`, `:496-502`, `:523-528`, `:675-680`; `src/engine/edit_log.cc:1309` and eleven appliers | One `refusedUnderLiveTake(kind, verb)`. | −60 |
| S11 | Fifteen hand-rolled tree walks in `src/engine/`, half through a recursive `std::function`, with `static_cast` and `dynamic_cast` mixed. | `take_service.cc` ×5, `island_geometry.cc` ×8, `transport.cc:97-107`, `device_service.cc:456-463` | `forEachNode` / `forEachClip` in `engine_internal.h`. | −70 |
| S12 | Rider tails and small idioms across the edit appliers: the origin + island tail ×3, sequence copy-swap-retire ×2, chain rebuild ×4, seven "swap one scalar" kinds of 9 lines each, the ancestor lift ×2. | `src/engine/edit_log.cc` (lines in the slice file) | Five small helpers. | −120 |
| S13 | The take-settle tail: `compactIdleTakes` restates `compactClipToHeap`; `startRecordingInNode` and `newTake` share an unshared tail; `reconcileTakes` and `importAudio` each restate compact + `pushUndo` + scrub. | `src/engine/take_service.cc:23-80`, `:340-383` vs `:451-477`, `:695-772`; `src/engine/import.cc:199-279` | One `settleCommittedTake`, one `armPerformance`. `known: D4-8`. Also where E7 is fixed. | −60 |
| S14 | The definer stack's shape is stated twice and its wrapper guard is subsumed by `hasActiveGeometryOutside`. | `src/engine/island_geometry.cc:61-81`, `:92-136`, `:123-132` | `definerStackImpl` over `isOneTakeStack`. | −57 |
| S15 | Built-in effect parameters are stated five times (set ladder, clamps, header comments, JS schema, mock defaults) with nothing pinning the JS schema to the C++ clamps. | `src/dsp/fx_chain.cc:20-102`; `src/dsp/effects.cc`; `src/dsp/effects.h`; `ui/js/effect_schema.js`; `ui/js/mock/effects.js` | A `constexpr` parameter table per slot; a contract test like the protocol one. | −50 |
| S16 | App-shell repeats: three window verbs restate table entries (one has drifted — the raw `loadSession`); plugin instantiation exists twice (and revival lives in `MainComponent`, so the headless server never revives a loaded session's plugins); optional-arg unpacking ×14; MIME ladder ×2; four verbs answer JSON text while the rest answer values, which is why the UI carries two tolerant parsers. | `src/main_component.cc:69-139`, `:247-282`; `src/bridge_dispatch.cc`; `src/headless/headless_main.cc:836-847` | Overrides call the table handler; `PluginHostService::instantiateAsync`; `optSamples` / `strArg`; answer values. | −105 |
| S17 | In the mock: the root is not a node (97 special-case references in 11 files — the three wrong root-frame reads live in those arms); twins justified by an import cycle that does not exist; timing math restated instead of imported; `popUndoForRefusal` hand-called at 51 sites. | `ui/js/mock/*` | A real root object; import the shared functions; one "unchanged graph records nothing" check in `callNative`. | −270 |
| S18 | Lane builders in the view model repeat fragments (the definer-member lane literal, the heard-reps recipe, `takeStartQ`, `inputChannel`, the fx-row push ×7, seq-chip facts ×2). The member copy of the definer lane has already lost `takeFields`. | `ui/js/view_model.js` (lines in the slice file) | Five helpers. | −130 |
| S19 | `session.css`: ~150 lines of identical or one-property-different blocks (`.input-menu` = `.take-menu`; `.seq-loop` = `.seq-cue` = `.seq-next`; two popovers; six compact chips; eleven separate `prefers-reduced-motion` blocks). | `ui/css/session.css` | Group selectors; one reduced-motion block. | −150 |
| S20 | `index_test.html` is a hand-kept copy of `index.html` plus a sidebar. It has drifted: ten ids exist only in `index.html` (zoom buttons, project menu, plugins button, odometer), so those are untestable there. `/?mock=true` already boots the same mock. | `ui/index_test.html` (216 lines); `ui/js/backend.js:29-49` | One page; mount the sidebar when `?mock=true&harness=1`; retarget six specs. | −216 |
| S21 | CMake lists the engine sources three times (app, headless, tests); `bridge_dispatch.cc` is in two of them and absent from the test binary. | `CMakeLists.txt` | One `CELESTRIAN_ENGINE_SOURCES` variable. | −45 |
| S22 | Smaller ones worth a line each: the scope-cycle law outside `period_law.h` (`stack_node.cc:336-347`, `heard_index.h:86-107`, `view_model.js:733-740`); the display-boost rule ×3 with copied constants (`canvas_renderer.js`, `live_peaks.js`); `app.js` restating view-model helpers; the seq chip and fx chip each patched twice (`rail.js` / `patch.js`); the step rename editor as a copy of the lane rename that lost its "unchanged" guard; `isLoopWindowActive()` and `activeTimeMap().active()` implemented twice per class. | | | −150 |

Two performance items surfaced on the way: `renderChildren` clears both
8192-sample scratch buffers at full capacity once per child per seam run
(`src/stack_node.cc:507`, `:533` — clear `num_samples` instead), and the origin
drift log builds two `std::map`s of every committed node on every poll
(`src/engine/island_geometry.cc:703-744`, called from `transport.cc:139`).

## 4. Things to split

| # | What | Where | Seams |
|---|---|---|---|
| P1 | `applyEditImpl` is one 812-line switch (Take/Untake 117 lines, Collapse 91, Remove 59, Definer 57…). Per-kind facts are scattered over six hand-kept lists (`kindName`, `content_edit`, the publish list, `liveUnderTake`, the gesture predicates, the dead `movesIslandFacts`). Every engine bug in §2.1 sits in a case too long to see whole. | `src/engine/edit_log.cc:404-1215` | One `applyX` per kind in four files — structure (~210), geometry (~480), takes (~210), chain + scalar (~130) — leaving `edit_log.cc` as the ~250-line log. One `KindTraits` table replaces five lists. `known: D6-8, D12-1`. |
| P2 | `view_model.js`: 3,195 lines, 78 top-level functions, one 385-line orchestrator, 1,486 comment lines. | `ui/js/view_model.js` | Eight modules behind a re-exporting facade (so all 47 importing test files keep working): `vm/published.js` (reading one node: map, periods, top, song), `vm/definer.js`, `vm/frame.js` (seat, zero, cycle, cursor, ruler, plus a `resolveFrame()` lifted from `deriveViewModel:2841-3024`), `vm/tiling.js`, `vm/sequence_rows.js`, `vm/lanes.js` (+ clip / group), `vm/pending_edits.js`. Acyclic import graph; mechanical move in that order. Also: `ctx` is half per-derive constants and half dynamic scope mutated and restored by hand around recursion (once with `try/finally`, three times without). |
| P3 | `app.js`: ten jobs in 1,653 lines behind a "glue" header. Nothing in it can be imported under node (it runs `initApp()` at import), so `windowLanded`, `trackRetakes`, `importVerdict` and `onArm`'s decision table have no unit test. | `ui/js/app.js` | `content_cache.js` (219-413), `edit_verdict.js` (71-176 + callbacks), `project_menu.js` (1019-1273), `record_verbs.js`, `structure_verbs.js`, `session_facts.js`; the calibrate wiring into `preferences.js`, the master monitor into `vu_meter.js`. Leaves ~450 lines. |
| P4 | `clip_node.h` carries 272 lines of message-thread bodies (collapse / splice / strip / restore / load) with 133 comment lines riding them; `clip_node.cc` is four files. | `src/clip_node.h:329-795`; `src/clip_node.cc` | `clip_node_takes.cc` (take list, comp, splice, load — all message thread), `clip_node_capture.cc`, `clip_node_render.cc`. Header drops to ~600 lines. This one move also removes S8. `known: D12-17`, still open (2,971 lines then, 3,201 now). |
| P5 | `ClipNode::control()` reads as dispatch for MIDI (`captureMidiBlock`) and as 130 inline lines for audio; `render()` inlines the live tail. | `src/clip_node.cc:99-310`, `:684-741` | `consumeStopRequest`, `wallGuard`, `captureAudioBlock`, `renderLiveTail`. `control` becomes ~25 lines that state the lifecycle. |
| P6 | `startRecordingInNode` (207 lines) interleaves collapse, target collection, S21 auto-target, through-map sizing with three refusals, and prepare/publish; `reconcileTakes` (152 lines) is a scan, a new-take settle, an Untake build and two repeated tails. | `src/engine/take_service.cc:178-384`, `:632-783` | `autoTargetCuedStep`, `throughMapCycle` (returns a refusal reason), `armPerformance`; `settleRetakes` + `settleCommittedTake`. Makes "validate, then mutate" a few lines. |
| P7 | `patchLaneBody` (~390 lines) is five jobs; its three overlay branches each repeat "patch cursor → frozen gate → keyed rebuild" and have drifted (two reported bugs). `region_panel.js` (1,054) and `map_core.js` (756) each hold several separable modules; `runRawDrag` takes 16 options, six of which exist to turn it into "not the raw drag". | `ui/js/session_view/lane_body.js:457-848`; `region_panel.js`; `map_core.js` | `patchReps`; three chrome builders behind one `patchOverlay(overlay, key, build, cursorFn)`; `map_moves.js` (the four pure move laws — the part most worth unit-testing without a DOM), `region_nav.js`, `region_nudge.js`. |
| P8 | `seq_grid.js` `rebuild()` is one 300-line function (37% of the file) — five of the eight bugs in that slice live in this file, and it has no unit-testable seam. | `ui/js/session_view/seq_grid.js:192-495` | `buildHeaderCell`, `buildPadRow`, `buildFooter` (+ radio chrome, orphan chips, health badges); move the row facts into the view model so `commit` and `buildSeqRow` share them. |
| P9 | `headless_main.cc` is five programs in one file. Its size is not duplication of the app shell (it consumes the shared method table); it is an inline HTTP server and an FFT chirp decoder. The decoder is the instrument every engine-e2e "listen" assertion trusts and has no direct test. | `src/headless/headless_main.cc` | `headless/chirp_codec.h` with a C++ test; `headless/http_server.h`. |
| P10 | `Edit` is a 45-field bag: `b1` has seven meanings, `d1/d2` carry int64 sample facts as doubles. The 99 comment lines on the enum are mostly "which kind reads which field". | `src/edit.h:142-350` | Named payloads (`MapPayload`, `IslandRider`, `OriginRider`, `CollapseFacts`, `SplicePayload`). Start with `d1/d2` → int64. `known: D6-8, D6-9`. |
| P11 | `AudioNode` has no `.cc`: 94 lines of `DynamicObject` building sit inline in the header every node TU includes, next to `ProcessContext`; `StackNode` doubles as the island-root record, which puts seven root-only no-op virtuals on the base. | `src/audio_node.h:316-409`, `:67-211`, `:478-508` | `audio_node.cc`; `process_context.h`; an `Island` record (`known: D14-1` stage 2). |
| P12 | `timeline_model.js`'s header says "mirrors `src/timing.h`; both pinned to the same golden vectors". About 180 of its 502 lines are; the rest is the period law, unpinned view-only readings, and sequence helpers. A reader trusting the header takes the unpinned part for pinned — and that part is where U6 lives. | `ui/js/timeline_model.js` | Keep the mirrors; `period_law.js` named after its twin; the rest to `vm/published.js` or deleted with S4. |
| P13 | Mock `armClip` (206 lines) mutates before it can refuse; mock `setLoopPoints` / `setSegments` (206 / 165) restate "Q := period, zero := origin′ + a0" four times with small differences. | `ui/js/mock/recording.js:406-612`; `ui/js/mock/maps.js:223-616` | `resolveThroughMap` (pure, run for all targets first), `armAt`, `reestablishFromDefiner`, `makeMembersWhole`. −120 lines. |
| P14 | `session.css`: the last 640 lines are appended in arrival order, the table of contents lists 21 sections against 26, and the z-index scale omits three tiers in use. | `ui/css/session.css:1-48`, `:2499-3137` | Minimum: re-home eight stray groups and regenerate the TOC. Better: six files along the TOC. |
| P15 | `island_geometry.cc` holds seven things (a structural helper, the definer predicates, `setDefiner`, continuity, Q18 anchoring, island Q writes, the scrub and the drift log). | `src/engine/island_geometry.cc` | `definer.cc` (~210 lines of pure tree queries). |

## 5. Tests

### 5.1 First: the C++ suite takes six and a half minutes, and three lines fix it

`CelestrianTests` runs in 390 s (measured; 5:56 for the Scenarios category
alone on your ordinary Debug binary). 344 s of that is three scenario oracles
calling `getGraphState()` once **per sample** — 840,000 full graph-state builds:

| Case | Line | Per-sample call | Before | After |
|---|---|---|---|---|
| S38 | `tests/scenario_tests.cc:1477` | `is.origin(kit)` inside the closure | 226 s | 2.2 s |
| S35 | `tests/scenario_tests.cc:1320` | `is.origin(g)` inside the closure | 82 s | ~1 s |
| S23 | `tests/scenario_tests.cc:719` | `is.zero()` in the compare loop | 40 s | ~1 s |

`Island::refresh()` caches clips only, so the two cases that needed a *stack's*
origin reached for the live accessor; the hazard is documented at
`scenario_utils.h:55-57` but nothing enforces it. I hoisted the three reads out
of the loops in the scratch copy and re-ran everything: **the whole suite
passes in 43 s** (Scenarios 31.6 s). The reviewer's follow-ups, not measured:
cache `captured` in `ClipFacts` so `loopVal` does one map lookup instead of
three (predicted ~28 s total), and a counter in `Island::state()` that fails
any expectation which reads the live graph per sample, so it cannot come back.

Smaller time sinks: `session_negative_tests.cc:156` sleeps 1.1 s to detect an
mtime change (set the file's mtime back an hour instead); `npm test` is a serial shell loop that stops at the first
failure (`node --test js/tests/` runs the same files in parallel with one
summary); the fuzzer is 6.7 s of the JS suite's 15; the mock e2e specs carry 54
fixed `waitForTimeout`s, about 12 s of ~88 s of case time in the loop-region
specs alone, most replaceable by a poll on an observable the specs already
import.

### 5.2 What line coverage can and cannot tell you here

The raw data says a great deal of test code is line-redundant:

| What-if (measured) | Test lines dropped | Coverage lost |
|---|---|---|
| Twelve older C++ suites (`regression`, `audio_engine`, `clip_node`, `pre_record`, `callback_edge`, `stack_loop`, `one_shot`, `solo`, `monotonic_clock`, `graph_snapshot`, `session_negative`, `seek`) | 5,065 | 5 lines (0.05 pt) |
| Those plus seven more with ≤ 22 unique lines | 7,210 | 73 lines (0.78 pt) |
| `scenario_tests.cc` alone | 1,841 | 20 lines (0.21 pt) |
| 17 JS unit files with no unique line in the unit layer | 2,303 | 0 |
| 34 JS unit files with no unique line once e2e is counted | 5,364 | 0 |
| All 79 JS unit files | 15,139 | 5.5 pt |
| 19 general e2e cases flagged for removal | ~600 | 23 e2e-only lines, 0 with unit |

But a line that *ran* is not a result that was *checked*. Every test reviewer
reached the same conclusion from its own slice: **line coverage is not the
binding constraint in this codebase; assertions are.** The unit files that add
no lines are, mostly, the only place a display law is asserted with numbers;
the e2e suite merely executes that code. So the recommendations below are
case-by-case judgements ("this assertion has a named twin at `path:line`"), with
the coverage data used to find where to look and to confirm that each proposed
deletion costs nothing measurable.

### 5.3 What can go

Reviewers' estimates, each backed by a per-file table and a twin for every
deleted assertion in the slice files:

| Slice | Lines today | Removable, no behaviour lost | More, if you accept thinner pins |
|---|---|---|---|
| C++ older unit suites (20 files + `test_utils.h`) | 7,642 | ~3,400 net (44%) | ~500 |
| C++ law suites + scenario harness (13 files) | 9,878 | ~1,850 (19%) | ~200 |
| C++ feature suites (24 files) | 7,935 | ~880 net (11%) | ~250 |
| JS unit, low-marginal files (38 + helpers) | 6,059 | ~1,040 (17%) | ~830 (mock fidelity), then ~500 |
| JS unit, the rest (41 files) | 9,242 | ~865 (9%) | ~980 (fuzzer + four mock registries, ~1 pt) |
| Mock e2e, general (14 specs) | 3,460 | ~1,025 net (30%) | ~75 |
| Mock e2e, loop region (6 specs + helper) | 3,215 | ~695 net (22%) | ~200 |
| Engine e2e (13 specs + helper) | 2,015 | ~156 (8%) | — |

Summed: about **9,900 of ~49,400 test lines (20%)** at no behaviour cost, and
about 3,500 more if you accept thinner pins — against a measured coverage cost
of a handful of lines. The three C++ reviewers each propose the same shared
header, so a little of that is counted twice.

Where it comes from, in order of size:

**0. Two whole C++ files.** `regression_tests.cc` (1,418 lines, 20 cases) is one
script sixteen times: record a 1Q clip, record a second at a hand-fed
`master_pos`, assert an origin or one sample. Its numbers are rows of
`shared/timing_golden.json` ("arm at 1500 in 4Q context → 2000 (slot 2, not
3)" is both a golden row and case R9), and its renders are what scenarios
S1–S3 check sample-exactly. Deleting all twenty cases loses exactly one source
line — `clip_node.h:222`, a getter only that file calls. Three later cases
(R18–R20) are S2 / S32 / S34 / S40 again; one (R1, arming starts a stopped
transport) is unique and moves to `monotonic_clock_tests`.
`audio_engine_tests.cc` (709 lines) goes the same way: eight of its ten cases
are vacuous or twinned (§5.4), and the two real ones move (8 lines into
`undo_tests`, one case into `solo_tests`). Also `pre_record_tests` cases 2–6,
seven of nine `stack_node_tests` cases, and five `clip_node_tests` cases. The
reviewer lists the 23 lines of assertions to port first so that nothing is
lost.

**1. A harness that every file rebuilds.** This is the largest single source
in all three layers, and it is pure mechanics.

- *C++.* `scenario_utils.h`'s `Island` already is the harness (heap engine,
  ramp driver, `findVar`, `record`, `settle`, `mismatches`). Outside it:
  `findVar` is defined 11 times, `lastTopLevelId` 9+, `clipIdsUnder` 6,
  `deepProp` 5, `rampAt` and a ramp driver 6 each, a "record one ramp take"
  recipe 5, `readWav` 3, `installStubSynth` 3. Helper preambles total ~750
  lines in the feature suites alone. Sequence payloads are hand-built 15 times
  (~155 lines in `sequencer_tests.cc`) although `scenario_tests.cc:37-77`
  already has a one-line `seqPayload`. `qtime_lock_tests.cc` has 17
  hand-written `process` lambdas and seven copies of a group-take recipe that
  is one `Island::recordGroup` call. `stack_origin_tests.cc` carries a private
  copy of the whole harness (`:26-163`).
- *JS unit.* `clip(id, originQ, durationQ)` exists in 7 byte-similar copies,
  `windowed` in 5, `island` in 9 variants, beside a second, incompatible
  builder family already in `helpers.mjs`. The "two tracks then a song" seed is
  copied 5 times (with two dead lines in it). DOM stubs ×5; local `near` ×9
  although `helpers.near` exists; `posMod` hand-rolled in 6 places.
- *e2e.* 25 inline copies of the page-boot prelude sit beside one canonical
  `boot()`; ~20 hand-rolled `getGraphState` readers; the same 10-line take
  recorder ×4 plus six variants; `splice_handles.spec.js` re-implements four
  helpers that `region_panel_helpers.js` exports; five per-animation-frame
  samplers; undo spelled five ways; `const Q = 44100` declared 17 times in the
  engine specs. One consequence is a real hole, not just bulk:
  `E2E_MOCK_RATE` (the sample-rate sweep `docs/test_harness.md` says both
  suites pass) is seeded by one spec file of twenty, so it re-rates 59 of 155
  cases.

**2. The same law pinned at several layers.** The direction differs by pair:

- *Mock-driven JS unit tests that replay C++ sequences* — about 2,100 lines,
  by the files' own headers ("mock twin of `tests/take_undo_tests.cc`",
  "Engine twin: … the same sequence"). `group_arm`, `take_undo`, `undo`,
  `structural_refusals`, `session`, most of `set_timing`. They protect the
  mock, not the product. Keep what a UI test builds on (commit, zero, undo
  coalescing, top reconcile); thin the rest.
- *JS unit vs mock e2e* — keep the unit, thin the e2e. The unit pins exact
  numbers in milliseconds; the e2e case that restates it costs a page boot.
  Named pairs: `reseat_tween.spec` 7 → 3–4 cases, `alt_mix_drag.spec` (the
  unit test cites it as its recipe), `session_view.spec:622-668` (the slowest
  case, 2.9 s of wall-clock sampling, twin of `playhead_clock.test:61`),
  `session_view.spec:1404-1539` (136 lines whose three phases each have a
  line-for-line twin in `splice_handles.spec` / `region_panel.spec`).
- *C++ scenarios vs feature suites* — the scenario keeps the audible
  consequence, the feature suite keeps bookkeeping facts with independent
  values. Four of seven `stack_origin_tests` cases are subsets of S10 / S21 /
  S25 / S37; three `qtime_lock` cases fold into S9 / S11 / S24; five
  node-level `sequencer_tests` cases are subsets of S17–S19 or of a golden
  vector. Every one of those 14 deletions was checked against the per-case
  profiles: 0 source lines lost.
- *The live-take gate* is asserted verb by verb in seven C++ places and eight
  JS files. It is one chokepoint; one table per layer covers it and also
  reaches the mock's refusal branches that no test executes today.
- *q13.test.mjs repeats stack_origin.test.mjs's group-trim laws* (~120 lines;
  `q13:377` itself says "pinned in stack_origin.test.mjs").

**3. Runs of near-identical cases that are tables.** `midi_release_tests` (four
cases, one trigger differs), `effects_stereo_tests` as the stereo twin of
`effects_tests`, the two bounce ↺ tests, 32 `gainAt` assertions in
`sequencer_tests`, `composite_waveform.test` (14 key subtests, 29 calls with
the same six-key literal), `map_edit.test`, four rename cases on one widget,
ten loop-window e2e cases sharing an 11-line setup, the ↺-drag family (six
cases that differ by topology and expected numbers).

**4. `session_view.spec.js`**: 1,848 lines, 59 cases, 389 comment lines. 39
cases execute no UI line another e2e case does not. The reviewer's
case-by-case table takes it to ~27 journeys (−650 lines), keeping the cases
that only a browser can pin: hit-tested drags, idempotent DOM writes under
typing and held sliders, DOM identity across a commit, focus rules, canvas
paint, the layout-stability law.

One thing I would *not* cut on line-coverage grounds, and no reviewer proposed
to: the golden-vector tests, the two contract captures, `render_purity`,
`seq_lock`, and the view-model law tests (`frame_seat`, `top_fields`,
`record_gate`, `under_map_slice`, `definer_gate`, `window_wrap`).

### 5.4 Tests that cannot fail

Higher value than any deletion, because each one is a false sense of cover.
"Confirmed" means I read both sides.

| Where | Why it cannot fail |
|---|---|
| `tests/take_capacity_tests.cc:47-61` (confirmed) | The process lambda passes one buffer as the input and both outputs. The callback clears outputs before it reads input (`audio_callback.cc:39-42`, `:86-93`), so every take in the file is silence and "audio identical through the swap" compares zeros. Separately its `compactIdleTakes()` calls are no-ops (the take is already compact and under the 2²⁰ slack threshold), so the "atomic content swap under a playing clip" in the header is tested by nothing. The same aliasing is in `qtime_lock_tests.cc:87-92`, `regression_tests.cc:1064`, `:1200`, `:1315` and `project_manager_tests.cc:26`. |
| `tests/audio_engine_tests.cc:207-282`; `tests/clip_node_tests.cc:358-391` (confirmed) | Four cases execute **zero** lines of `src/` in the coverage run: they define their own `gcd` / `lcm` lambdas or re-implement `launchPointFor` inline and test that. |
| `tests/audio_engine_tests.cc:449-538` | "Nested Stack Must Use Recursive LCM" asserts only `pos > 0`; its own comment computes 0.5Q under the bug and 1.5Q under the fix. Same shape at `:284-377` (`pos_after > pos_before` on a monotonic clock) and `:539-703` (165 lines ending in an identity of `launchPointFor`). |
| `tests/stack_node_tests.cc:234-351` | Three loop-window cases assert `outL[0] > 0` on a clip holding DC 0.5 — true under any mapping, including none. |
| `tests/audit_regression_tests.cc:62-109` | E1 deletes a clip while a take is live; `record()` refuses at the gate before the applier it guards can run, so the assertion holds with or without the fix. |
| `tests/callback_edge_tests.cc:371-382` | "xrun heuristic does not count idle gaps" produces neither an idle gap nor a real one; it passes with the detector deleted. |
| `tests/session_io_tests.cc:243-267` (confirmed) | "Different-rate load" never varies the rate: `load()` uses the device rate only when the bundle has no `sampleRate`, and `save()` always writes one. |
| `tests/engine_bridge_tests.cc:231-256` | "Prepares before enabling": the clip is empty and unmonitored, so the enabled reverb never sees a sample and the VU is 0 either way. |
| `tests/sequencer_tests.cc:836-857` | Saves a *root* whose sequence `session_io::save` does not write, then asserts only "save ok, load ok, one child". The "bypassed survives" claim in its comment is asserted nowhere. |
| `tests/sequencer_tests.cc:558` | Titled "… mid-take refusal"; the body never arms a take. |
| `tests/timing_golden_tests.cc` (17 sites), `tests/qtime_tests.cc` (4) | `if (auto* cases = root.getProperty("X").getArray()) { for … }` with no check that the key exists. Rename a fixture key and the C++ half of the cross-language pin goes green on zero iterations. `period_law_tests.cc:76` does it right. |
| `ui/js/tests/fuzz_loop_region.test.mjs:63-124` (confirmed) | The three known-bug lists are empty, so `suppressed()` always returns false and `FUZZ_STRICT` toggles nothing — 55 comment lines narrate a campaign whose bugs are all fixed. |
| `ui/js/tests/heard_tile_sampler.test.mjs:303-337`, `:363-372`, `:410-416` | "Teeth" blocks that paste in a deleted algorithm and prove it was bad. They cannot fail from a regression in today's path. |
| `ui/e2e/sequencer.spec.js:145-167` | Sets two 3Q steps on a fixture whose frame is already 6Q, then waits for the readout to say 6Q. |
| `ui/e2e/region_panel_view.spec.js:250-290`, `:323-355`; `ui/e2e/release_chrome.spec.js:274-302` | Three cases still test the pre-dock panel layout: the teleport walk cannot reach a docked panel, the dock is outside the scroll area by construction, and the third asserts the absence of a mask that was deleted. |
| `ui/e2e/splice_handles.spec.js:871`; `ui/e2e/session_view.spec.js:970`, `:1478`, `:1523`, `:1538` (confirmed) | `toHaveCount(0)` on `.loop-top-chip` and `.midi-btn`, classes no source file produces. |
| `ui/e2e/release_chrome.spec.js:395` | Asserts "no bridge calls" by parsing console text with no positive control; a changed log format makes it pass forever. |
| `ui/e2e_engine/cursors.spec.js:33-36` | The expected playhead position is computed by `deriveViewModel` — the expression under test — and never consults the engine. |
| `ui/js/tests/engine_replay.test.mjs:24-30`, `display_contract.test.mjs:26-32` | When the C++ capture file is missing they `process.exit(0)`: a fresh clone's `npm test` goes green having run neither. |
| `tests/seam_fade_tests.cc:305-332` | Only `expect(false)` on mismatch, so it contributes zero passes. |

Also from the test run itself: 114 test names and messages contain non-ASCII
characters in plain string literals, which trips a JUCE assertion on each —
131 `juce_String.cpp:327` lines per run that bury real output and would break
into the debugger on a Windows Debug run.

### 5.5 Missing coverage

Ranked by the damage a regression would do. The first group is where a
missing test and a likely bug coincide.

| # | What nothing tests | Where | Why it matters |
|---|---|---|---|
| 1 | **A generic "apply → undo → redo restores the graph" check.** Undo is tested per scenario with hand-picked assertions (child count, one property). | `tests/undo_tests.cc`, `take_undo_tests.cc` | A helper that compares the serialized graph before an edit and after its undo, run over one fixture per `Edit` kind, would have caught E1, E2 and E3. `known: D6-16`. |
| 2 | **MIDI takes beyond the first** are never created, saved, loaded, selected, spliced or undone. | `src/session_io.cc:307-314`, `:440-442`; `src/clip_node.cc:1858-1938` | The mirror rewrites `session.json` every 3 s, so a regression silently drops every MIDI take but one and persists the loss at once. ~70 lines of test. |
| 3 | **Loading a project over an engine that already has a song.** | `src/session_io.cc:545-549`, `:766-768` | Project A's song keeps sounding in B and the next mirror saves it into B's folder; or a use-after-free. ~40 lines. |
| 4 | **Splice at lock-collapse across N takes, and across MIDI.** | `src/clip_node.cc:2011-2096`; `src/clip_node.h:761-795`; `src/engine/edit_log.cc:737-769` | The other takes are the user's comping material; none of this code has ever run under test. |
| 5 | **A real drag on the real engine.** No engine-e2e case drags a splice, the ↺, a bracket or the panel marker; `setTiming`, `loopTop` and `retime` appear nowhere in `ui/e2e_engine/`. | `ui/e2e_engine/` | The whole loop-region redesign is verified against the mock only — exactly the drift that suite exists to catch. One ~50-line case reusing the existing drag helpers. |
| 6 | **Nine user verbs in `app.js` are wired to reachable chrome and called by no test in either layer**: rail drop-to-group, selection-bar Group, Ungroup, move to top level, Solo, Delete (✕), the pan dial, the VST3 name click, creation-menu Import. | `ui/js/app.js:577-666`, `:1379`, `:1405`, `:1512`, `:1584`, `:1603` | E1 is reachable through exactly the first two. A spec comment says "Solo is unit-covered"; the unit tests cover the view model and the mock, not the button. |
| 7 | **Seek with a deleted subtree in the undo log.** | `src/engine/transport.cc:99-107` | Delete a track, scrub the ruler, undo: the revived track would sit off by the scrub distance. |
| 8 | **`bridge_dispatch.cc` is not linked into the C++ test binary.** | `CMakeLists.txt` | Arity guards, `setTiming`'s non-finite refusal, `setSegments`' flat-array decode, the `saveTrackTemplate` argument transposition are tested only by well-formed UI calls. The contract test compares method names, not parameters. |
| 9 | Live MIDI through a stack that splits its block; a gated child that is itself a splitting stack. | see E4, E5 | The two confirmed kernel bugs have no test that could see them. |
| 10 | The cue re-base in the message-thread descent (`heard::receivedAt`). | `src/heard_index.h:172-178` | It feeds the continuity re-anchor, the definer hand-off and the S21 arm; the audio twin is covered, this is not. |
| 11 | Refusal families: `newTake` (six refusals), take-list verbs under a live take, `setSegments` (incoherent period, empty clip), take caps (32 takes, 256 comp cells), import error paths. | `src/engine/take_service.cc:390-565`; `map_edits.cc`; `import.cc:48-146` | Each is a table of "graph and undo log unchanged". |
| 12 | **No engine-level run in the production configuration.** `test_runner.cc:46-47` turns seam fades and transport fades off for all 44 scenarios. | `tests/test_runner.cc` | Groups, windows, comps and nested maps through the engine's run-splitting with fades on are exercised nowhere. |
| 13 | The fuzzer drives 6 of the mock's 25 undoable verbs. Its undo/redo and "refused edit records nothing" invariants are verb-agnostic. | `ui/js/tests/fuzz_loop_region.test.mjs:305-312` | ~40 lines adds `setTiming`, `setDefiner`, `setPeriodSource`, `newTake`, `setSequence`, `reorderNode`. |
| 14 | A windowed or cut **one-shot** lane's trim grips and seam handles: ~110 lines that execute in no run. | `ui/js/session_view/map_bands.js:431-575` | Either an untested edit surface or dead code — an owner call. Same question for the `.win-cursor` machinery (`lane_body.js:712`, `:832`, `:859-902`). |
| 15 | The plugin registry panel (15% covered), the device picker and latency-calibration flow, the production bridge's event path, the project-menu verbs (Duplicate, Save as template, New from template, Open recent, ⌘S, ⌘O). | `ui/js/plugin_panel.js`; `audio_settings.js`; `bridge.js`; `app.js:1162-1249` | The mock's deterministic plugin scan exists for a test that was never written. |
| 16 | The headless server's chirp decoder — the instrument every engine-e2e listen assertion trusts. | `src/headless/headless_main.cc:303-377` | See P9. |

Not gaps: `device_service.cc` (46% covered, hardware-bound), the Windows-only
branch of `take_storage.cc`, and `tests/stub_plugin_instance.h` (its 26
never-called functions are the pure virtuals JUCE forces on any plugin
subclass).

## 6. Documentation

### 6.1 The numbers

Comment lines against code lines, measured over tracked files:

| Area | Code | Comment | Ratio |
|---|---|---|---|
| `src/` | 13,108 | 6,775 | 0.52 |
| `ui/js` core | 5,206 | 4,110 | 0.79 |
| `ui/js/session_view` | 5,979 | 3,032 | 0.51 |
| `ui/js/mock` | 3,571 | 1,802 | 0.50 |
| C++ tests | 20,068 | 3,164 | 0.16 |
| JS unit tests | 11,192 | 2,835 | 0.25 |
| e2e (both) | 6,315 | 1,788 | 0.28 |

The files where a reader pays most:

| File | Code | Comment | Ratio | Longest block |
|---|---|---|---|---|
| `ui/js/view_model.js` | 1,604 | 1,486 | 0.93 | 90 lines |
| `src/audio_engine.h` | 319 | 708 | 2.22 | 22 |
| `src/clip_node.h` | 519 | 534 | 1.03 | 21 |
| `src/audio_node.h` | 344 | 484 | 1.41 | 27 |
| `src/edit.h` | 123 | 218 | 1.77 | 22 |
| `ui/js/protocol.js` | 89 | 194 | 2.18 | 18 |
| `ui/js/canvas_renderer.js` | 211 | 253 | 1.20 | 38 |
| `ui/js/composite_waveform.js` | 113 | 170 | 1.50 | 41 |
| `src/session_io.h` | 50 | 102 | 2.04 | 29 |

Your instinct is right, and the reviewers converged on the same three causes
in every slice.

**1. One law, many homes.** Each law is told in the header, again at the
applier, again at each consumer, and often a fourth time in the mock. Examples
the reviewers counted:

- "Mute is the pre-fx gate so tails ring": 8 sites across `audio_node.h`,
  `stack_node.cc`, `sequence.h`.
- "The audio thread never walks parents; it uses the snapshot": about 14 sites.
- "The engine reads no frame; the view seats the zero": 8 sites in
  `src/engine/` and 6 more in `ui/js`.
- The re-time law, the Q hand-off, lock-collapse, and live coalescing: four
  homes each (`audio_engine.h`, `edit.h`, `edit_log.cc`, `map_edits.cc`).
- "Never rebuild the overlay while a handle holds capture": stated in full in
  six session-view files.
- "A held control must not be overwritten by the tick" (`_hot`): seven files.
- In the mock, "engine parity" appears 167 times and "a refused edit records
  nothing" 21 times; `mock/undo.js:72-95` is `edit_log.cc:75-101` nearly
  verbatim.

The fix is the same everywhere: state each law once at its owner and cite it
by name elsewhere (`// heard view (displayPeriodQ)`), which is what
`.agent/style.md` already asks for.

**2. History where the present law should be.** The style rule bans dates,
audit ids, "used to", "field video", "round N". A scan for those markers finds
128 comment lines in `src/`, 154 in non-test `ui/js`, and 376 in the tests.
Most are a hazard followed by the incident that revealed it — keep the first
sentence, drop the second. Worst blocks: `ui/js/session_view/splice_handles.js:1-79`
and `:176-188`, `region_panel.js:1-75`, `map_bands.js:1-38`,
`src/engine/island_geometry.cc:318-349` (32 lines above a 20-line function),
`src/clip_node.cc:1259-1268` (ten lines narrating a removed fold),
`ui/js/view_model.js:1145-1193`. Seven citations in `src/` point at
`unification_audit.md` as live law; it is in `docs/archive/`.

**3. Catalogues that go stale.** Hand-kept field lists that the code has
outgrown: the `deriveViewModel` header's lane-field catalogue (90 lines,
partial, and wrong in places), `session_io.h:15-43`'s "canonical" field list
(omits takes, comp, MIDI, monitor, pan, gain — `known: D7-11`), the `ctx` field
list in `view_model.js:2363-2366` (names a field that does not exist, omits 15
that do), `session_view.js:14-32`'s module list (omits 11 of 34 modules),
`mock_backend.js:17-32`'s module list, the `session.css` table of contents.

**Removable without losing a law** (reviewers' estimates, per slice):

| Slice | Comment lines today | Removable |
|---|---|---|
| `view_model.js` + model files | ~1,900 | 450–500 |
| Mock | 1,802 | 700–900 |
| App shell + renderers | 2,011 | ~450 |
| Engine facade + edits (`audio_engine.h`, `edit.h`, `edit_log.cc`, `map_edits.cc`) | ~1,500 | ~450 |
| Kernel core (`audio_node.h`, `stack_node.*`, …) | 1,727 | 370–430 |
| Loop-region UI | 2,258 | 220–260 |
| Engine services | 724 | ~210 |
| Clip node | 1,121 | 150–170 |
| Periphery (session, bridge, plugins, DSP) | ~1,100 | ~110 |
| Session-view shell + CSS | 1,413 | 110–130 |
| **Total** | **~15,700** | **~3,200–3,600 (about a fifth)** |

The per-slice files name each block with its line range and the short form it
would shrink to. The three with the best return: the `deriveViewModel` header
(`view_model.js:2721-2810`, 90 → ~25) together with its result literal
(`:3119-3194`, ~70 → ~25); `ProcessContext`, which is documented twice — a
27-line grouped summary then ~105 lines of per-field comments repeating it
(`audio_node.h:40-211`); and the verb docs in `audio_engine.h`, where
`seekTransport`, `bounce`, `importAudio` and `setSequence` each carry ~20 lines
restating a doc while `setLoopPoints` — the verb with the most behaviour — has
three.

### 6.2 Comments that are wrong

About 115 comments contradict the code they sit on. These cost more than long
ones, and several directly caused or hid a bug in §2. The ones most likely to
mislead:

| Where | Says | Is |
|---|---|---|
| `ui/js/bridge.js:44-50`, `:5-6` | The direct call is "the path that runs in production"; the event path is "a fallback" | Reversed (U7) |
| `ui/js/protocol.js:7`; `src/main_component.h:13-16`; `.agent/style.md:58` | Bridge registrations live in `main_component.cc` | The table is `bridge_dispatch.cc` — this misdirects anyone adding a bridge method |
| `ui/js/session_view/window_edit.js:69-71` | "Multi-segment maps never reach here" | Clips do (U1) |
| `src/dsp/fx_chain.h:49-52` | A re-prepare "is safe while audio runs" because the rate only changes with the device stopped | Nothing prepares then (E6) |
| `src/audio_node.h:482-484`; `src/stack_node.h:202-203`; `src/stack_node.cc:193-195`; `src/engine/transport.cc:193-196`; `src/engine/import.cc:255-257` | The commit event "drives the zero re-base" | `takeCommitted` discards both arguments and moves no fact |
| `src/audio_node.h:89-93`; `src/stack_node.h:267-269`; `src/stack_node.cc:274-278`; `src/time_map.h:14` | Window phase is `(t − frame_top) mod period` | The code folds from the node's own origin (`known: D11-3`, recorded as one line; there are four) |
| `src/time_map.h:18-20`; `src/clip_node.h:390`, `:446-448`; `src/engine/take_service.cc:342-347` | A "map override" shadows the window atomics and is retired through the reclaimer | There is one stored `TimeMap`; `setLoopPoints` is `setMap` |
| `src/audio_engine.h:444-449`; `src/edit.h:116-123` | `setPeriodSource` and `Timing` are "Clips only" | Both are fractal; a scenario calls one on a group |
| `src/engine/map_edits.cc:35-36`, `:123-125` | "Sibling windows stay editable" under a take | Refused by `record()`; a test pins the refusal |
| `src/engine/edit_log.cc:209-210` | A node with a multi-segment override "is left alone" | The body captures and replaces it |
| `src/session_io.h:99-103`; `src/session_io.cc:132-134`; `src/project_manager.h:131-134` | The incremental mirror is a length probe | It skips on existence and rewrites on `takeFilesDirty`; another comment in the same file says a length probe cannot work |
| `ui/js/view_model.js:1012-1014`; `ui/js/timeline_model.js:206`, `:393-395` | These are "the JS twin of" engine functions | The named functions no longer exist; the real twin is `islandCycle`, which the view model does not call (U6) |
| `ui/js/view_model.js:1281-1282`, `:1301-1302`, `:1955-1962`, `:2741-2742`; `ui/js/app.js:50-54` | The mock keeps the slot's `duration` during a retake | It publishes the live length and `periodQ`, as the engine does |
| `ui/js/qtime.js:81-83` | `qMulInt` is kept because "the C++ side uses it" | No such C++ function; it is dead |
| `ui/js/session_view/gesture.js:154-163`; `selection.js:21-24`, `:82-85`; `teleport.js:10-14` | The region panel is a row under the selected lane, so a claim at press moves the lane | The panel is docked; the machinery this justifies is a no-op (§7) |
| `ui/js/session_view/region_panel.js:751-757` | The strip canvas is wider than the strip and translated | It is strip-wide and re-sampled |
| `ui/js/session_view/lane_body.js:740-743`, `:918-920`; `dims.js:3-4` | Describe the "expanded drag" as current | It does not exist |
| `ui/js/mock/recording.js:3-5`, `:791-793` | "heard-frame origin fold" | `:769-772` says "no heard-frame fold", and the code agrees; the variable is still `foldedOrigin` |
| `src/clip_node.h:381` | "the multi-segment twin of `collapseToWindow`" | No such function |
| `src/headless/headless_main.cc:536-537` | `reset()` drops the history | It never clears it; the next spec's first undo resurrects the previous spec's last node |
| `src/clip_node.h:252-255` | The wall guard "auto-finishes cleanly … never a silent zombie" | See E9 and E13 |

Also misattached doc blocks (a JSDoc sitting on the wrong function):
`view_model.js:665-674`, `:1068-1076`, `:1622-1633`; `map_core.js:158-160`;
`audio_engine.h:996-998`; `mock/recording.js:27-42`; `mock/cycles.js:73-79`.

### 6.3 Where a comment is missing

Few places, but each one would have prevented something in §2:

- `src/stack_node.h:455-527` `forEachSeamRun` does not say which context fields
  are block-relative and must be re-sliced per run. E4 and E5 are that omission.
- `ui/js/view_model.js:635-636` `fadeSegsOf` takes one step-indexed and one
  visit-indexed array with no note. That is U3.
- `src/clip_node.h:878` `write_position` has no comment and three meanings
  (heard samples during capture; absolute recorded extent after commit;
  `duration` for a loaded MIDI take), and is an `int` among `int64_t`s.
  `is_playing` next to it is the content-sounds gate, not transport.
- `src/project_manager.cc`: 17 comment lines for 220 of code. Missing: who sets
  the three identity fields; `base()`'s resolution order and that the test
  override *shadows* `setBase`; the two side files and their shapes; that the
  root getters create their directory on every call (on a 2 s poll).
- `ui/js/session_view/seq_grid.js`: the header explains the product grammar,
  not the code. Missing: the lane shape it consumes; the three index spaces
  (`i` step, `k` column, `ci` child); the row's expando state; that `commit`
  mutates `row._lane` only and the DOM changes at the next poll.
- The lane shape in the view model has no definition; it is assembled by
  `Object.assign` layers whose *order* is load-bearing.
- About 35 ad-hoc DOM properties (`body._bandState`, `row._region*`,
  `strip._nudge`, `band._lastLive`, …) are the cross-module state of the
  loop-region UI and are written down nowhere; two findings are one going stale.
- The mock's raw node carries about ten private fields with no statement of
  unit or frame; `_precollapse` has three shapes under one name.
- `src/audio_engine.cc:89-95`: the destructor removes the audio callback but not
  the MIDI callback; it is safe only because of member declaration order, which
  nothing says.

## 7. Dead code

I confirmed the first four by coverage (never executed by any of the 490 cases)
plus a repo-wide grep; the rest are reviewers' greps.

**Engine**

- `movesIslandFacts` (`src/engine/edit_log.cc:1388-1404`) is never called and is
  kept compiling by `juce::ignoreUnused(&movesIslandFacts)` at `:1415`.
- `AudioNode::renderOrigin()` (`src/audio_node.h:872`), `ClipNode::takeRecorded`
  (`clip_node.h:606`, `clip_node.cc:1864`), `HeldNotes::channelMask`
  (`midi_sequence.h:165`): definition only.
- The commit event's payload: `StackNode::takeCommitted(origin, intrinsic_after)`
  discards both arguments, yet the clip still runs `snapIntrinsicDuration` — a
  whole-graph LCM walk **on the audio thread** — to compute one
  (`clip_node.cc:1618-1620`). With it go `lcm_before_take_`,
  `activeTakeIntrinsicCycle`, `GraphSnapshot::Entry::type`. About −55 lines.
- `Edit::node2` (never assigned); `findNodeByUuid`'s `node` parameter (all ~45
  callers pass the root); `addVst3SlotToChain` (tests only); five
  `AudioEngine` methods public with no outside caller.
- `StackNode::getWaveform`'s 34-line aggregate and `getCurrentPeak` (the UI
  composites groups client-side; a stack's `currentPeak` is always 0).
- `Sequence::isPlainLoop`, `songToContent`; `qcmp` / `qadd` / `qsub` / `qlcm`
  and their JS twins (test-only on both sides); `period_law::drifts` and both
  `contributionOf` overloads (test-only); `ProcessContext::map_count`
  (`known: D1-4`).
- `lastTemplate`: written to `state.json` on every template use, read only by a
  test — while the UI tells the user the template "loads automatically next
  launch". Delete the state or implement it.
- `LoadedSession::display_name` / `created` (never read); `MirrorMode::FULL_REWRITE`
  (`known: D7-14`); `init(int inputs, …)`'s unused parameter; a dozen
  `root_node` null guards on a pointer assigned once; `pushUndo(…); clearRedo();`
  pairs where `pushUndo` already clears redo.
- `warpPointer`: no caller anywhere, kept "for protocol parity" across four
  layers (`protocol.js`, mock, `main_component.cc:153-181`, headless). −40 lines.
- `tests/stub_plugin_instance.h` is 64% covered with 26 of 36 functions never
  called (most are required pure-virtual overrides; see the test section).

**UI**

- **The claim-at-gesture-end machinery** (`gesture.js:62-67`, `:154-272`;
  `selection.js:21-46`; `claim:` threaded through five call sites). It existed
  so a lane would not move under the hand when the panel opened beneath it.
  The panel is now docked and handles exist only on the selected track;
  `docs/loop_selection.md:611` says it "stays and is a no-op". Its one remaining
  effect is collapsing a multi-selection on a handle gesture. Decide that rule,
  then delete: −55 lines of code, −60 of tests.
- `bridge.js`: the direct-call branch, `onReady`, the `bridge-ready` event and
  `window.bridgeInited` (U7).
- `body._flashT` (cleared, never set); `drag.kind !== 'length'` (never that
  kind); `teleport.js:43`'s `.lane-region` branch (and the unit test pinning
  it); the `engage` option of `runRawDrag` (always `true` in production);
  `isDragging(body)` pre-guards the singleton already covers.
- View model: `laneCommon`'s `state` parameter (threaded through seven call
  sites, the only reason `ctx.state` exists); `recordingHeadQ`'s `restZero`
  with its 7-line rationale; unreachable stack branches in `windowEditLane`;
  three always-equal ternaries. −40 lines.
- `timeline_model.js` `periodQ` (no importer); `qtime.js` `qMulInt`;
  `calculateStackLCM`'s `maxDuration`.
- Mock, ~90 lines: `periodExcluding` (its "engine parity" names a function that
  no longer exists), `effectivePeriodOf`, `driftsNow`, `applyTwoAnchorContinuity`,
  `auditionMap`, `wasPushedThisCall`, `committedCycle`, the `excludeIds`
  parameter, five unused imports.
- `session.css`: no dead class selectors — the stylesheet is in sync with the
  DOM. Six dead or inert rules (~12 lines): `#audio-device-btn`, two
  `#calibration-status` rules in the wrong section, three no-op restatements.
- `index.html:167` `#ready-lamp`: a static "Engine ready" lamp no code drives.
- Six `seq_grid.js` leftovers (`row._cols` written and never read; an
  unreachable fallback; `closeTakeMenus()` in a handler a PANEL binding
  pre-empts).

## 8. Suggested order of work

**Tier 0 — hours each, no ruling needed.**

1. The three-line hoist in `scenario_tests.cc` (§5.1). Everything after this is
   cheaper to verify.
2. E1 + E2 (Combine guard, Explode order) with their two regression tests.
3. E3 (fold the coalesced inverse's riders).
4. E6 (sweep effect chains in `audioDeviceAboutToStart`).
5. E10 (`ProjectManager::flush()` on quit and switch), E11, E12.
6. U1 (wire the chip before the guard), U2, U3, U8 — four one-to-six-line fixes.
7. Delete the confirmed dead code in §7 and fix or delete the tests in §5.4.

**Tier 1 — a day or two each.**

8. S1: one scope-facts read per phase in `forEachSeamRun`, with per-run MIDI
   and gate slices (E4, E5), and the two tests that could have seen them.
9. E7: the reconcile guard (three lines) now; "store Idle last" with the
   recording-lifecycle work the kernel audit already schedules (`D4-9`).
10. E8 + E9 before the next Windows session: one "furthest sample this take may
    touch" value used by the arm, the grower and the guard.
11. U7: make the event path the bridge's only path.
12. The generic undo-restores-the-graph test (§5.5 #1), then the save/load
    tests for MIDI takes and for loading over a song (#2, #3).

**Tier 2 — structural, each unlocks later work.**

13. P1: split `applyEditImpl` per kind with a traits table. Every reproduced
    engine bug sat in a case too long to read whole.
14. S2: one map-commit verb.
15. S3 + S4: `publishedMap` in `time_map.js` and the frame from `islandCycle`
    (U5, U6, the definer trim view).
16. The shared test harness in all three layers (§5.3 #1). Most of the test
    reductions are mechanical once it exists, so do it before cutting cases.
17. P4: move the take-edit bodies out of `clip_node.h`.

**Tier 3 — the reading-cost work.**

18. The `view_model.js` split and its comment diet together (P2, §6): moving
    functions is the natural moment to give each law one home.
19. The same pass over `audio_engine.h`, `edit.h`, `audio_node.h`, and the mock.
20. `app.js` split (P3); one popover helper (S6); `seq_grid.js` (P8).
21. In the mock: the root as a real node, and a differential script against
    `CelestrianHeadless` in place of reading for parity (§2.7).

## 9. Questions only you can answer

1. **Bypassed multi-segment map at arm time.** A bypassed single window is not
   collapsed; a bypassed cell map is spliced. Which is the law?
   (`edit_log.cc:710-746` vs `:304`)
2. **Arming through the definer stack.** Its own record button skips the
   lock-collapse; a member's button performs it. Intended?
   (`take_service.cc:199-203`)
3. **A handle gesture with several tracks selected** collapses the selection to
   that track. Keep that, or leave the selection alone? The answer decides
   whether the claim machinery is deleted or reduced to one line. (§7)
4. **Can a one-shot still carry a window or a cut?** If yes, its trim grips and
   seam handles need a test; if no, ~110 lines in `map_bands.js` are dead.
   Same question for the `.win-cursor` on heard lanes.
5. **Import onto a stack: one undo step or two?** The engine does two; the doc
   and the mock say one.
6. **Refusable void verbs.** The engine answers `true` for every void bridge
   verb, refused or not; the mock answers `false`. Should they answer a bool,
   so the status line can stop announcing success for a refused delete?
7. **`lastTemplate`.** Delete the write-only state and fix the status text, or
   implement the auto-load it promises?
8. **How much mock fidelity do you want pinned by tests?** About 830 lines of
   JS unit tests replay sequences the C++ suites own (§5.3). They protect the
   mock from drifting; a differential script (item 21) would do that better.
9. **`getCommitMasterPos`, `launchPoint`.** Write-only telemetry kept alive by
   tests. Drop both?

## Appendix A — the engine repro tests

Compiled and run against HEAD in the scratch build; all four fail today (the
fourth with SIGSEGV). They use `tests/scenario_utils.h`.

```cpp
// E2 — undo of a group restores the wrong sibling order
AudioEngine engine;
engine.createNode("clip"); engine.createNode("clip"); engine.createNode("clip");
const juce::StringArray before = topIds(engine.getGraphState());   // [T, X, D]
engine.combineNodes(before[2], before[0]);                          // group D with T
engine.undo();
expect(topIds(engine.getGraphState()) == before);                   // got [T, D, X]

// E1a — a group dragged onto its own member vanishes
const juce::String g = engine.combineNodes(a, b);
const int had = reachable(engine.getGraphState());                  // 3
engine.combineNodes(g, a);
expect(reachable(engine.getGraphState()) >= had);                   // got 0

// E1b — a member dragged onto its own group, then undo
Island is;
const juce::String c1 = is.record(20000), c2 = is.record(is.Q());
const juce::String grp = is.engine.combineNodes(c1, c2);
is.engine.combineNodes(c1, grp);
is.engine.undo();                                                   // SIGSEGV

// E3 — a coalesced gesture's undo leaves the origin moved
Island is;
is.record(20000);                              // the definer; Q = 20000
const int64_t Q = is.Q();
const juce::String b = is.record(8 * Q);
const int64_t o0 = is.iprop(b, "origin");
is.driveToPhase(posmod(o0 - is.zero() + 5 * Q, is.cycle()));
is.drive(Q / 2);                               // playing 5.5Q into the clip
is.engine.setLoopPoints(b, 0, 4 * Q);          // removes the sounding half
is.engine.setLoopPoints(b, 0, 7 * Q, true);    // live: covers it again
is.engine.undo();
expectEquals(is.iprop(b, "origin"), o0);       // got o0 − 2Q
```

## Appendix B — where the detail is

Each reviewer wrote a findings file with `path:line` evidence, the fix, and a
confidence for every item (the tables above compress about 350 findings into
one line each). They are in this session's scratchpad, which is temporary:

`/private/tmp/claude-501/-Users-lincolnfrog-code-celestrian/bb12659e-a1d0-46e3-9aaf-e6cb16973fef/scratchpad/`

| File | Slice |
|---|---|
| `findings/A1_clip_node.md` | `clip_node.*`, take storage, MIDI sequence |
| `findings/A2_kernel_core.md` | `audio_node.h`, `stack_node.*`, `sequence.h`, time math |
| `findings/A3_engine_edits.md` | `audio_engine.h`, `edit.h`, `edit_log.cc`, `map_edits.cc`, `verbs.cc` |
| `findings/A4_engine_services.md` | take service, island geometry, callback, transport, bounce, import, devices |
| `findings/A5_periphery.md` | session I/O, bridge, app shell, plugins, DSP, headless |
| `findings/B1_view_model.md` | `view_model.js`, `timeline_model.js`, `time_map.js`, `map_edit.js` |
| `findings/B2_app_shell.md` | `app.js`, renderers, bridge, small chrome modules, the two HTML pages |
| `findings/B3_loop_region_ui.md` | lanes, region panel, splice handles, gestures |
| `findings/B4_session_view_css.md` | sequencer grid, rails, menus, `session.css` |
| `findings/B5_mock.md` | the mock backend |
| `findings/TC1_cpp_classic_tests.md` | twenty older C++ suites, case by case |
| `findings/TC2_cpp_law_tests.md` | scenarios, sequencer, time-map, Q-lock suites; the run-time analysis |
| `findings/TC3_cpp_feature_tests.md` | session, takes, MIDI, effects, plugins, projects |
| `findings/TJ1_js_unit_low_marginal.md` | 38 JS unit files with little unique coverage |
| `findings/TJ2_js_unit_rest.md` | the other 41 JS unit files; unit ↔ e2e pairs |
| `findings/TE1_e2e_general.md` | `session_view.spec.js` case by case, 13 smaller specs |
| `findings/TE2_e2e_loop_region_engine.md` | loop-region specs and the engine e2e suite |
| `data/cpp_per_test.tsv` | every C++ case: covered lines, unique lines, ms |
| `data/cpp_uncovered.txt` | per `src/` file, the line ranges no test runs |
| `data/js_all_coverage_report.txt` | per UI file and per test file, both layers |
| `data/e2e_per_case.tsv` | every Playwright case: covered, unique, ms |
| `cov/tests/audit_repro_tests.cc` | the four repro tests in full |
| `b1probe/`, `b5_probe*.mjs` | the view-model and mock probes |

The coverage build is reproducible: source-based coverage flags on the
`src/` and `tests/` translation units only, and a `UnitTestRunner` subclass
that writes and resets the LLVM profile in `resultsUpdated()` whenever a new
`beginTest` starts (`cov/tests/test_runner.cc`, 110 lines).

## Appendix C — status after the fix pass (2026-10-12)

Everything above describes the tree at commit 0910949. This appendix says
what became of each item in the fix pass that followed (uncommitted when
written). What is still OPEN, with the state that shows it and the ruling
it needs, lives in `docs/tasks.md` Tier G — that is the durable list; line
numbers above no longer match the code.

**Verification on the final tree** (project objects rebuilt from disk):
`Celestrian`, `CelestrianHeadless`, `CelestrianTests` build; C++ suite 530
cases, all pass, 0 assertion lines, ~33 s (was ~390 s); JS unit 927 / 927;
mock e2e 177 passed; differential (mock vs engine) 107 journeys + 96 walks,
0 diffs, no known-drift entries; engine e2e 32 passed.

| Items | Outcome |
|---|---|
| §2.1–2.2 E1–E13 | All fixed, each with a test that failed first. E8 and E9 are fixed by reading and by test on macOS; neither has been run on Windows. |
| §2.3 engine, reported | Fixed where reproduced (take lifecycle, session / project / plugin periphery, kernel). Later finds, also fixed: first take's cursor, negative cursor after a backward seek, arm one block early at a split block, first-take undo dropping songs, a no-op edit logging an undo step, the first take's stop committing on the message thread, a designated definer's collapse lifting its group, the device-stop sound-off swallowing a note. |
| §2.4–2.5 U1–U8 | All fixed with tests. |
| §2.6 UI, reported | Fixed where reproduced (session view, sequencer grid, one-shot lanes, comp grid, retake period, raw tile mapping, resting one-shot cursor). |
| §2.7 mock ↔ engine drift | A differential harness (`ui/differential/`, `npm run test:diff`) drives both with the same verbs and compares published state and every answer. 39 drift families → 0. |
| §3 S1–S6, S8–S21 | Done. S9's and S12's last copies: the output stage is one function; the chain rebuild keeps two sites that differ (which slots, who frees). S22's small ones were taken where a package was in the file; not checked off one by one. |
| §3 S7 | The reader is one (`Sequence::fromVar`); the writers were not unified. |
| §4 P1–P9, P12–P15 | Done (`applyEditImpl` → one applier per kind; `view_model.js` → `ui/js/vm/*`; `app.js` → shell modules; the clip in four files; …). |
| §4 P10 | Partly: `Edit::d1/d2` are `i1/i2` (`int64_t`); the field bag stands. |
| §4 P11 | Not done: `AudioNode` still has no `.cc`. |
| §5.1 suite time | Done: 390 s → 33 s. |
| §5.3 test reductions | Done in two passes per layer against a twin ledger (a case deleted on a twin keeps a KEEP-side twin). Net test code did NOT shrink: thinning removed ~7,000 C++ lines, ~2,600 JS unit lines and ~2,400 e2e lines, and the fixes and the missing-coverage work added about as much or more (C++ tests 25,530 → 25,522 lines; JS unit 15,301 → 19,643; mock e2e 6,675 → 7,842, of which 620 are shared recipes; plus the new differential harness, 4,454). |
| §5.4 tests that cannot fail | Fixed or deleted, plus about ten more found on the way (a ramp-decode tolerance that hid a five-sample slip; `/on/` matching `mono`). |
| §5.5 missing coverage | Added: undo symmetry over every edit kind, take lifecycle, bridge dispatch, the app shell modules, track / project / plugin e2e, golden vectors for the laws that gained a twin. |
| §6 documentation | Comment lines: engine `src/` 6,787 → 5,705; UI 7,142 → 6,506 (in 101 files, was 68); mock 1,802 → 727. Wrong comments on the §6.2 list fixed. `docs/` and `.agent/` brought up to the code. |
| §7 dead code | Removed, including members only tests read. Left because tests still read them: `capHit`, `isPlainLoop`, `songToContent`, `period_law::drifts`. |
| §9 questions | 1, 3, 4, 5, 6, 7, 8, 9 ruled and applied. 2 (a track recorded inside the defining group) is open as `docs/tasks.md` Open Design Question 12. |

Files left as empty stubs for a `git rm` at commit: `tests/regression_tests.cc`,
`tests/audio_engine_tests.cc`, `ui/e2e/alt_mix_drag.spec.js`,
`ui/e2e/monitor.spec.js`, `ui/e2e/region_panel_helpers.js`.

# Celestrian codebase pass — 2026-08-09

Scope: C++ engine (`src/` + `tests/`), per request: style, duplication, test
coverage, documentation. Every change was verified against the full test
suite (now 218 test groups, up from 182), and the whole refactor diff was
independently adversarially reviewed for behavior preservation before
delivery. **55 files changed, +3547 / −2167 lines.**

---

## 1. Real bugs found and fixed

**SIGFPE (undefined behavior) in the coherence guards** — `src/audio_engine.cc`,
`setLoopPoints` and `setSegments` computed `len % q` / `p % q` *before*
checking `q > 0`. Integer mod-by-zero is UB: on Apple Silicon it silently
yields 0 (why it never fired on your Mac), on x86 it crashes the process.
The baseline test suite actually crashed on Linux inside
`time_map_record_tests` because of this. Both guards now check `q > 0`
first (extracted into one shared predicate, `isPeriodCoherentWithQuantum`,
so the twins can't drift again).

**`.clang-format` silently not enforcing your pointer style** — the config
said `PointerAlignment: Left`, but `BasedOnStyle: Google` also sets
`DerivePointerAlignment: true`, which overrides the explicit setting and
infers alignment per-file. That's how ~480 `Foo *x` declarations
accumulated against the style guide's `Foo*` rule. Added
`DerivePointerAlignment: false` and reformatted; the config now actually
enforces what `.agent/style.md` documents.

**Portability of the test suite** — `(int64_t)someVar` casts of `juce::var`
are ambiguous where `int64_t` is `long` (Linux); changed the affected
casts in tests and `main_component.cc` to `(juce::int64)`. Also added
`JUCE_WEB_BROWSER=0` / `JUCE_USE_CURL=0` to the `CelestrianTests` target so
the console tests build on headless Linux (no gtk/webkit/libcurl needed).
No effect on macOS builds.

**Stale doc fixed** — `session_io.h` still claimed clip WAVs are mono; they
have been stereo-capable since the stereo work. Corrected.

## 2. Style

- `clang-format` run over all of `src/` and `tests/` with the corrected
  config: pointer alignment, access-specifier indentation, wrapping — all
  now match Google style + left pointers, and stay that way because the
  config is fixed.
- Truncated names cleaned up where local (effects module: `thr/rat/atk/rel`
  → `threshold_db/ratio/attack/release`, `fb/wet/dl/dr` → full words,
  `spec` → `spectrum`, etc.). RBJ cookbook variables (`A`, `w0`, `cw`) kept
  deliberately, with a comment saying why (line-by-line checkability
  against the reference).
- Magic numbers in the DSP module named: `kLowShelfHz`, `kMidPeakHz`,
  `kMidQ`, `kHighShelfHz`, `kShelfSlope`, `kMaxEchoSeconds`,
  `kEnvelopeFloor`, `kSpectrumMinHz/MaxHz/RangeDb`, etc.
- `using namespace` removed from the two test files that had it.
- `stack_node_tests.cc`'s registration instance renamed
  `boxNodeTests` → `stackNodeTests` (leftover "box" terminology); dead
  commented-out `enterBox`/`exitBox` test block deleted.
- **One inconsistency unified with a tiny behavior note**: the "no device
  yet" sample-rate fallback was 44100 in two places and 48000 in one (the
  VU ballistics). All three now share `AudioEngine::kFallbackSampleRate`
  (44100). Only observable before any device has started.

## 3. Duplication removed

`src/`:

- `AudioEngine::pushUndo` — the depth-cap/evict/clear-redo tail was
  copy-pasted between `record()` and `combineNodes()`.
- `AudioEngine::retireOwned<T>` — replaces 14 hand-rolled
  `retire([p]{ delete p; })` lambdas and the release-then-retire dances.
- `AudioEngine::appDataFile` — the override-or-appdata shape shared by
  `calibrationFile()` and `audioDeviceFile()`.
- `AudioEngine::prepareEffects` — the prepare-before-enable sequence
  duplicated in `setEffectEnabled` / `setEffectScope`.
- `AudioEngine::attachTransportState` — `getGraphState`'s two branches
  each hand-built the same 9 properties; the sets had already started to
  drift (only the fallback published `quantum`/`nodes` — preserved, now
  explicit).
- `AudioEngine::isPeriodCoherentWithQuantum` + `attachContinuityRiders` —
  the Q13 coherence guard and the two-anchor continuity rider were
  duplicated between `setLoopPoints` and `setSegments`. (Note: the two
  callers judge the delta against *different* quantum scopes — root vs
  target — which differ for combine-created stacks; that asymmetry is
  preserved exactly and now documented at the helper.)
- `StackNode::forEachSeamRun<Ch>` — the sub-block seam-split loop existed
  as two ~35-line const/non-const twins in `control()`/`render()`; both
  phases must see the same mapped clock run-for-run, which one shared
  driver now guarantees by construction.
- `StackNode::ChildView` — the snapshot-vs-ownership child lookup lambdas
  duplicated between `controlChildren`/`renderChildren`.
- `timing::foldPeriod` — the LCM composite-fold accumulate rule existed in
  5 places (both StackNode folds, both graph_snapshot twins, and
  `childContext`); the Q5 one-shot exclusion stays visible per-site.
- `ClipNode::finishCaptureBlock` — the ~40-line capture bookkeeping tail
  (peak telemetry, write-position advance, PendingStop crossing,
  through-map wall) duplicated between the ring and live-block paths.
- `AudioNode::qtimeVar` is now the one QTime→JSON serializer;
  `session_io.cc`'s byte-identical private copy forwards to it (save
  format and metadata path can no longer drift).
- `EffectRack::kSlotNames` — the `{"eq","compressor","echo","reverb"}`
  list was hard-coded in two `session_io.cc` loops; now one constant in
  canonical signal order.
- `dsp/effects.cc` — the mono/stereo method pairs shared their whole
  parameter-load + gain-computer / delay-tap / scope-capture logic:
  extracted `FxCompressor::loadCoefficients` + `gainStep`,
  `FxEcho::loadParameters`, `Biquad::shelfTerms`,
  `EffectRack::captureScope`. Each stereo path is now a small loop over
  shared math instead of a 25-line copy.

`tests/` — new `tests/test_utils.h` (~220 lines) absorbing ~490 duplicated
lines: `driveEngine` (the block-driver loop, 9+ copies), `nodesOf` /
`isClipCommitted` / `recordClip` (4 files), `findSharedFile` / `asInt64`
(golden-vector loaders, 2 files), `runLoopback` (2 files), `freshTempDir`
(4 files), and the graph-state accessors (2 files). Copies that fed
*different* input signals were deliberately left in place rather than
changed behaviorally.

## 4. Test coverage added (36 new scenarios, 5 new files)

- **`tests/effects_stereo_tests.cc`** — the stereo DSP paths had *zero*
  coverage (~90 lines of production DSP reached by any stereo clip or
  panned group with an effect on). Now pinned: per-channel EQ/echo state
  independence, the stereo-linked compressor (one envelope, same gain both
  sides), reverb stereo tail, rack passthrough bit-identity, unknown
  id/param `false` returns, param clamping, and the
  enabled-before-prepare fail-silent path.
- **`tests/engine_bridge_tests.cc`** — `setNodePan`/`setNodeGain` clamping
  (the no-boost law) and their non-undoability; `setNodeInput[Right]` undo
  round-trips incl. `-1` reverts-to-mono; `setNodePosition` drag
  coalescing (10 drags = ONE undo step); LoopBypass undo/redo;
  `setEffectEnabled`/`setEffectParam` through the engine (the
  prepare-before-enable ordering was previously bypassed by every test);
  the `kUndoDepth = 128` cap with eviction safety (130 creates, 140
  undos).
- **`tests/session_negative_tests.cc`** — the suite previously contained
  *no negative `ok` assertion at all*. Now: missing dir, missing
  session.json, malformed JSON, missing WAV (degrades gracefully — clip
  keeps its JSON duration with empty content; pinned), `readBundleInfo`
  failure paths, incremental save skip/rewrite semantics (the Q13
  lock-collapse coupling), and `loadSession` refusing mid-take +
  clearing undo history after load.
- **`tests/project_lifecycle_tests.cc`** — `tick()`'s mid-take guard (the
  crash-safety contract), `saveNow()` birthing an unborn project,
  `ensureLaunchSession()` ("never boot into an empty screen" + Default
  template), `duplicateProject()` forking, empty-rename fallback,
  `listTemplates`.
- **`tests/callback_edge_tests.cc`** — zero-sample callbacks, mono/null
  output channels (VU right-mirror), zero input channels while armed, the
  VU envelope-follower attack/release ballistics (retuned twice in the
  field, previously untested), the reclaimer's 2-callback grace (the
  lifetime invariant the whole lock-free design rests on), RtLog's bounded
  drain under a post storm (the 2026-07 field-hang fix had no regression
  test), and the xrun heuristic.

## 5. Documentation

The codebase's comments were already exceptional; additions were kept to
where they carry real information: a threading-model overview on
`AudioEngine` (the message/audio-thread contract and the three sharing
mechanisms), the three-layer bridge handshake warning on `MainComponent`,
an architecture summary on `ClipNode` (state machine / content model /
playback equation), doc comments on every newly extracted helper stating
its contract (e.g. `finishCaptureBlock`: "callers must not touch capture
state after this returns — nothing may follow a commit"), and the
`session_io.h` mono→stereo correction. No noise comments were added.

## 6. Reported, deliberately not changed

- **Dead code** (zero call sites): `timing::qmulInt` (left — likely API
  symmetry with the JS qtime mirror), `StackNode::setEpoch`,
  `ClipNode::getSampleCount`, `ClipNode::throughMapCommitCycle`,
  `EffectRack::isPrepared`, `EffectRack::scopeActive`. Also the MSVC
  `Int128` fallback in `qtime.h` is never compiled or tested on
  macOS/Linux — if Windows ships, that's untested arithmetic inside the
  rounding law.
- **Peak-metering divergence** (flagged with a comment in
  `clip_node.cc`): the ring capture path meters only the *captured*
  channels; the live-block path meters *all* delivered input channels.
  For an unassigned-but-hot input they report different peaks. Needs a
  ruling on which is intended before unifying.
- **Zero-sample callback xrun quirk**: a 0-sample block makes the xrun
  heuristic's period 0, so any small gap increments the counter once.
  Cosmetic; noted in `callback_edge_tests.cc`.
- **Public atomics on `AudioNode`/effects** deviate from the style guide's
  no-public-members rule, but each carries a documented threading
  rationale — treating them as a deliberate, documented exception rather
  than churning ~20 files of RT code. Same for the `num_samples`/
  `master_pos`-style truncations (`.agent/style.md` wants `sample_count`/
  `master_position`): they appear in ~250 places across the
  `ProcessContext` API and every test; a mechanical rename is possible
  but was out of proportion for this pass — say the word and I'll do it.
- **Boolean parameters** (`mirror(bool)`, `chooseSessionPath(bool)`,
  `setPeriodSource(uuid, bool)`, the five unnamed multi-bool
  `AudioBuffer::setSize` calls) — the style guide prefers enums; small
  blast radius each, listed for a future pass.
- **`regression_tests.cc`** still carries 19 near-identical ~50-line
  scaffolds (~1000 of its 1440 lines); consolidating them would churn a
  file whose value is historical fidelity. `test_utils.h` is ready if you
  want them ported.
- **`main_component.cc` bridge boilerplate**: 48 `withNativeFunction`
  registrations of ~85% identical signature/arity-guard code, and the
  style guide's "all native functions MUST log" rule is followed by only
  2 of 48. A `voidCall`/`valueCall` adapter would fix both in one place —
  left alone because the GUI target isn't test-covered.
- **`snapEffectiveCycle`'s `quantum <= 0` fallback branch** and the
  device-selection block (`getAudioDeviceState`/`setAudioDevice`) remain
  untested — the latter genuinely needs device mocking.

## 7. Verification

- Full suite: **218 test groups, all passing** (`exit=0`), run after every
  commit in the series (14 commits, cleanly separated: portability → format
  → test consolidation → refactors → docs → new tests).
- The GUI target's sources (`main_component.cc`, `main.cc`) compile
  cleanly too (checked on Linux with webview enabled; only the final link
  needed platform curl wiring this sandbox lacks), so those changes are
  compile-verified, not just formatted.
- An independent adversarial review of the full `src/` diff hunted for
  extraction drift, ordering hazards, and RT-safety regressions. It found
  exactly one real drift (the continuity rider's quantum scope in
  `setSegments`) — which was then fixed to preserve baseline semantics
  bit-for-bit; everything else verified CLEAN.

One environment note: the test suite allocates an 8.5&nbsp;GB *virtual*
take reservation at arm (by design, D4). Linux CI boxes need
`vm.overcommit_memory=1` (or ≥9&nbsp;GB RAM) to run the suite — macOS
needs nothing.

# VST3 Hosting: Effects & Instruments

> Status: **proposal, rulings ratified** — written 2026-08-15; owner
> rulings on the §9 questions recorded 2026-08-15 (see the table).
> Additional ruling: **no session back-compat** — "you really don't have
> to worry about existing sessions, I don't have anything that needs to
> be salvaged" — so the legacy `effects`-object loader and the type-id
> bridge compatibility below are DROPPED; §6/§7 carry dated notes.
>
> Owner-ruled scope (2026-08-15):
> the milestone covers BOTH effect plugins and instrument plugins, built in
> phases so effects hosting lands first and the MIDI/instrument
> infrastructure builds on top of it. Chain model ruled: the fixed built-in
> rack becomes a **dynamic per-node chain** in which the four built-ins and
> VST3 plugins are peer slots (the outcome `dsp/effects.h` anticipated:
> "the dynamic-chain complexity arrives with VST3, which will replace the
> rack's internals, not its bridge surface"). Plugin UIs ruled: **native
> floating editor windows**, opened from the web UI over the bridge.

This doc defines the hosting architecture, the audio-thread discipline for
plugin processing, the persistence format, the UI/bridge surface, and the
phase plan. It cites performance.md §1 (project law), the D4 atomic-pointer
discipline, and kernel.md's content-agnostic timing facts rather than
restating them.

---

## 1. Goals & non-goals

Goals, in phase order: host third-party VST3 **effects** as insert slots on
any node (clip or stack — the fx path stays fractal); refactor the fixed
rack into a dynamic chain without changing what existing sessions sound
like; open each plugin's own editor in a native window; persist plugin
state through save/load including graceful missing-plugin round-trip;
then build **MIDI input, note clips, and instrument hosting** on the same
chain machinery.

Non-goals for this milestone: parameter automation lanes (plugins manage
their own parameters through their editors), sidechain routing, VST2/AU/
LADSPA formats (AU on macOS is cheap later — the hosting layer is
format-generic — but it is not in scope), plugin sandboxing/out-of-process
hosting (scan crash protection *is* in scope; §4), and plugin delay
compensation beyond latency *reporting* (§7 explains why PDC in a cyclic
kernel needs its own ruling).

## 2. Background & constraints

Today every node owns a `dsp::EffectRack`: four fixed slots (EQ →
Compressor → Echo → Reverb), all-atomic parameters, mono + stereo process
paths, prepared on the message thread before first enable. Clips run the
rack over `fx_scratch_`/`fx_scratch2_` after rendering content; stacks run
it over the summed group in `fx_accum_`; both feed the output stage
(gain·pan) afterward. The bridge surface is `setEffectEnabled` /
`setEffectParam` / `setEffectScope`, keyed by `EffectRack::kSlotNames`;
session_io serializes a per-node `effects` blob keyed the same way.

Everything reachable from the device callback obeys the audio-thread
contract (performance.md §1: no locks, no allocation, no I/O, one
structure load per callback, retirement through the reclaimer). Render is
CONST with sanctioned mutable DSP scratch (§2.3). Plugin hosting must fit
inside this: the chain is published like the D4 content buffer (one atomic
pointer, message-thread swaps, reclaimer retirement, audio thread loads
once per block).

One honest caveat, stated once: `processBlock` of a third-party plugin is
code we do not control. A badly written plugin can allocate or lock on the
audio thread. Every DAW lives with this; our contract governs *our* code —
we prepare plugins off-thread, never instantiate/destroy them on the audio
thread, and never let chain *structure* operations touch the callback.

Licensing: JUCE bundles the VST3 SDK headers (`juce_audio_processors`
hosting support); the VST3 SDK is dual-licensed Steinberg / **GPLv3**, so
the GPLv3 option combines with this project's AGPLv3 exactly as the ASIO
SDK does (see the CMakeLists ASIO comment for the §13 mutual-permission
reasoning). No extra SDK download is needed.

## 3. The chain model

### 3.1 Slots

`dsp::FxChain` replaces `EffectRack`'s internals. A chain is an ordered
vector of **slots**; a slot is one of:

- **Built-in**: owns one of the existing `FxEQ` / `FxCompressor` /
  `FxEcho` / `FxReverb` objects, unchanged DSP. Type ids stay `"eq"`,
  `"compressor"`, `"echo"`, `"reverb"` — the ONE list the bridge,
  metadata, and save format key on, exactly as before.
- **VST3**: owns a `juce::AudioPluginInstance` plus its identity (plugin
  uid + `fileOrIdentifier`), an atomic enabled flag, and the last-known
  state blob (for missing-plugin round-trip, §6).
- **Instrument** (phase 5): a VST3 instrument at the chain head of a MIDI
  clip — same slot machinery, different I/O shape (§8).

Every slot carries a stable slot uuid (juce::Uuid at creation, persisted)
so the bridge and UI address slots positionally-independently across
reorders. *(Ruled 2026-08-15, no-back-compat: the bridge moves WHOLLY to
slot-uuid addressing in phase 2 — `setEffectEnabled`/`setEffectParam`
change signature to take a slot uuid instead of a type id, and the UI
migrates in the same phase. No type-id compatibility shim.)*

A fresh node's default chain is the four built-ins in canonical order, all
disabled — byte-identical audible behavior to today.

### 3.2 Publication (the D4 discipline, verbatim)

`AudioNode` holds `std::atomic<const dsp::FxChain*> chain_`. All structure
mutations (add/remove/move slot, plugin instantiation results) happen on
the message thread: build the successor chain — *reusing* the untouched
slot objects by move, so DSP state (echo lines, plugin state) survives a
reorder — publish it with one `exchange`, and retire the predecessor
through `AudioEngine::retire()` (the 2-callback grace covers an in-flight
render that already loaded the old pointer). The audio thread loads the
pointer once per block and only ever reads it.

Parameter and enable changes are NOT structure: they mutate atomics inside
slot objects shared by predecessor and successor chains, exactly like
today's rack atomics. Dial drags never republish.

`prepare()` runs on the message thread before a slot can be enabled or a
chain published, as today. For VST3 slots prepare means
`setRateAndBufferSizeDetails` + `prepareToPlay(rate, maxBlock)` with the
device's maximum block size (cached in `audioDeviceAboutToStart` alongside
the rate); processing shorter blocks than prepared is legal. A device
rate/block change re-prepares every chain on the message thread before
audio restarts (the engine already sequences `audioDeviceAboutToStart`).

### 3.3 The audio-thread process path

The chain keeps the rack's exact call shape so clip_node.cc and
stack_node.cc barely change: `chain->process(l, n)` and
`chain->processStereo(l, r, n)`, in-place, no-op when nothing is live.
Internally each enabled slot runs in order; a VST3 slot wraps the channel
pointers in a preallocated-header `juce::AudioBuffer<float>` (the
pointer-referencing constructor — no copies, no allocation) and calls
`processBlock` with an empty (preallocated) MidiBuffer.

**Channel shape ruling:** VST3 effect slots are always instantiated and
prepared **stereo (2 in / 2 out)** — the overwhelmingly supported layout.
On a node whose fx path is running mono (`process`), the chain *promotes
to stereo at the first enabled VST3 slot*: the mono signal is copied into
a preallocated right-channel scratch inside the chain, both channels run
from there on, and the node's render path treats the fx output as stereo
from that point (clips already have the stereo scratch pair; stacks
already run `fx_accum_` with ≥2 channels). Built-in slots after the
promotion use their existing stereo paths. A chain with no enabled VST3
slots behaves exactly as the mono rack does today — no behavior change
for existing sessions. (Q-V1 in §9 records the rejected alternative.)

**Pan is unaffected by promotion** (owner question, answered 2026-08-15):
pan applies AFTER the chain at the output stage, per channel under the
balance law (`outputStageGains`). A mono signal duplicated to L/R and
then panned is bit-identical to today's mono path, which multiplies the
same mono buffer by `gl` into left and `gr` into right — the existing
output stage already *is* pan-by-gain on the promoted pair. No emulation
layer needed; nothing changes in the pan code.

The scope capture (pre-rack telemetry ring) moves to the chain unchanged —
it captures pre-chain, gated on the panel being open.

### 3.4 Latency

`FxChain` exposes `totalLatencySamples()` — the sum of enabled slots'
`getLatencySamples()` (built-ins report 0), recomputed on the message
thread at publish/enable time into an atomic, published in node metadata
for the UI to display ("⚠ 512 smp" on the effects bar). **No
compensation in this milestone** — see Q-V2 (§9) for why PDC in a cyclic
kernel is its own design problem and the proposed direction (read-ahead,
not delay-others).

## 4. The hosting layer

A new message-thread-only service, `PluginHostService` (owned by
MainComponent or the engine — placement per ui.md's bridge rules):

- `juce::AudioPluginFormatManager` with `VST3PluginFormat` registered.
  (Format-generic by construction; AU later is one `addFormat` call.)
- `juce::KnownPluginList`, persisted as XML in the app data dir
  (`userApplicationDataDirectory/Celestrian/known_plugins.xml`).
- **Out-of-process probing** (src/plugin_scan_worker.h, after the
  2026-08-19 field crashes): every file is probed in a scanner
  subprocess (the app binary relaunched with a handshake flag, per
  JUCE's AudioPluginHost pattern). A plugin that crashes or hangs while
  it loads kills only the subprocess; the file is blacklisted and the
  scan walks on. The subprocess probes on ITS message thread, which
  also satisfies plugins that call main-thread-only macOS APIs during
  load (the NI/TSM crash class).
- The standard **dead-man's-pedal** file stays as the second line of
  defense: before probing a file, write its path; on clean completion,
  clear it. If the app itself dies mid-scan, the next launch blacklists
  the named file and persists the blacklist at once (an in-memory
  blacklist would be lost to a second crash).
- Scanning runs on a background thread (`PluginDirectoryScanner`) over
  the platform default VST3 directories + a user-added list; progress and
  results stream to the UI over the existing event channel.
- Instantiation: `createPluginInstanceAsync` on the message thread;
  the completion lambda builds the slot, prepares it, and publishes the
  successor chain (§3.2). The UI shows the slot as "loading" from the
  optimistic add until the publish event.

## 5. Editor windows

VST3 editors are native views; the main UI is a webview — so editors live
in **floating native windows**, standard DAW behavior. One
`PluginEditorWindow : juce::DocumentWindow` per open slot, owning
`plugin->createEditorIfNeeded()`; close deletes the editor (never the
instance); reopening recreates it. Windows are message-thread objects
keyed by slot uuid in PluginHostService; closing a node/slot closes its
window first (editor before instance, always). Plugins without an editor
get JUCE's `GenericAudioProcessorEditor` in the same window — the web UI
does not grow a generic parameter panel (ruled out with the native-window
ruling; the built-ins keep their existing web panel via effect_schema.js).

## 6. Persistence

The per-node `effects` blob becomes an **array** (chain order), each entry
`{slot: <uuid>, type: <id>, enabled: <bool>, ...}`:

- Built-in entry: `type` is the canonical id, params inline exactly as the
  current per-effect objects (`{type:"echo", enabled:true, time:0.35,…}`).
- VST3 entry: `{type:"vst3", uid, name, fileOrIdentifier, state:<base64>}`
  where `state` is `getStateInformation`'s MemoryBlock, refreshed at save
  time on the message thread.

**Back-compat: none** (ruled 2026-08-15 — no existing sessions to
salvage). The loader reads the array form only; the legacy
`effects`-object replay is not built. A legacy blob encountered on load
is ignored (the node gets the default chain) rather than erroring the
whole session load.

**Missing plugin on load:** the slot is created as a *placeholder* — no
instance, audio path is a hard bypass, UI badge "missing" — but it keeps
`uid`/`fileOrIdentifier`/`state` verbatim, so save→load→save never sheds a
plugin the user merely hasn't installed on this machine. If a scan later
finds the plugin, the placeholder can be revived in place (publish a
successor chain with a live slot restored from the kept state).

Undo ruling (mirrors the existing effect-params ruling): chain *structure*
edits (add/remove/move slot) are undoable Edit events; enable flips and
parameter changes are not (dial-drag flooding — same reasoning as pan and
gain). A removed slot's plugin instance is owned by the undo entry like a
displaced content buffer (never freed inline; the redo-branch invalidation
frees it through the reclaimer).

## 7. Bridge & UI surface

New bridge methods (webview native functions, same adapters as today):
`getKnownPlugins()`, `scanPlugins(paths?)`, `addPluginToChain(nodeUuid,
pluginUid, index)`, `removeChainSlot(nodeUuid, slotUuid)`,
`moveChainSlot(nodeUuid, slotUuid, newIndex)`, `openPluginEditor(nodeUuid,
slotUuid)`, and `setSlotEnabled(nodeUuid, slotUuid, on)`. *(Ruled
2026-08-15, no-back-compat: `setSlotEnabled` REPLACES `setEffectEnabled`,
and `setEffectParam` re-keys to `(nodeUuid, slotUuid, key, value)` — the
type-id addressing is deleted in phase 2, UI migrated in the same
change.)* Parameters remain built-in-only — VST3 parameters belong to
their editors.

Effects bar (ui_overhaul.md): renders the chain array from node metadata
in order — built-ins with their existing mini-panels (effect_schema.js
unchanged), VST3 slots as named chips with enable toggle, missing/loading
badges, and click-to-open-editor; a "+" chip opens the plugin picker fed
by `getKnownPlugins`. Reorder by drag within the bar. Latency badge when
`totalLatencySamples > 0`.

## 8. Instruments & MIDI (phases 4–6)

Nothing in `src/` touches MIDI today; this is new infrastructure, staged
so each piece is independently shippable. The kernel is content-agnostic —
origin/period/quantum/launch are facts about *time*, not audio buffers
(kernel.md) — so a note clip slots into the timing model unchanged; what's
new is capture, storage, and rendering.

- **Phase 4 — MIDI input + live play-through.** ✅ DONE 2026-08-15 —
  `MidiInputQueue` (lock-free SPSC ring, channel messages only, drop-
  and-count overflow), engine as the all-devices `MidiInputCallback`
  (device enabling happens in the APP shell at startup + heartbeat, so
  headless tests stay device-free), one drain per callback into a
  preallocated MidiBuffer riding `ProcessContext.live_midi` (events at
  block offset 0 — sub-block onset jitter is inaudible for monitoring;
  finer recording timestamps are phase 5's). Instrument slots:
  `Vst3Slot(is_instrument)` prepares 0-in/2-out, consumes MIDI via the
  new `FxSlot::processStereoMidi` hook, and OVERWRITES the buffer (the
  chain-head generate semantic); the flag rides add/save/revive. The
  armed node (`AudioNode::midi_armed`, single-armed via
  `setMidiArmed`, a monitoring gesture like solo — not undoable, not
  persisted) hands the block's events to its fx pass; a clip with no
  content/transport renders a silence pass through the chain (the
  play-through tail — never a SECOND chain run in one block), stacks
  get it free via their every-block fx pass. UI: `getMidiInputs`
  diagnostics. *(The ♪ rail toggle shipped here was retired 2026-08-18
  — owner ruling "it should just always be monitoring if it's
  selected": the MIDI target FOLLOWS SELECTION — app.js
  syncMidiTarget reconciles setMidiArmed to the most recently selected
  instrument lane every poll, a MIDI take in progress winning; the
  MIDI chip on the rail lights ♪ for the current target.)*
- **Phase 5 — note clips + recording.** ✅ DONE 2026-08-18. Built as
  planned with one structural choice made in the spirit of Q-V3 rather
  than its letter: instead of a separate `MidiClipNode` class, `ClipNode`
  gained a **content kind** (`ContentKind::{Audio, Midi}`,
  `midi_sequence.h`) — the take lifecycle (arm → capture → stop → commit,
  quantum snapping, through-map fold, epoch re-base, undo entries) is
  content-agnostic and lives in ClipNode, so a MIDI take reuses it
  *verbatim* and only the ingest/render differ (`captureMidiBlock`,
  `renderMidi`). The kind is decided AT ARM from the clip's own chain
  (an instrument slot ⇒ MIDI track; `hasInstrumentSlot`) and fixed for
  the take; the UI's "MIDI track" affordances key on the published
  `contentKind` (also `"midi"` for an empty clip with an instrument —
  its next take records notes; the rail shows a ♪ MIDI chip where the
  audio-input picker was, since a note take has no audio input).
  Content: a fixed-capacity `MidiSequence` (POD events `{pos, bytes,
  size}` in the origin frame — samples in the engine, QTime in the save
  format per Q-V4 — reached through one atomic pointer, D4 verbatim;
  arm-time reservation, drop-and-count at the wall). Capture is the
  note twin of the pre-record ring: the engine drains the FIFO by
  **arrival timestamp** (sub-block offsets, MidiMessageCollector rule)
  into an input-clock-indexed `MidiHistory` ring; a recording clip
  reads its window from it — `content 0 ↔ arrival(target + midi_lat)`
  where `midi_lat` is OUTPUT latency only (a key pressed on the heard
  beat has no input-side device delay; `ProcessContext.midi_latency`,
  driver-reported output figure or half the measured round trip) — so
  the pickup and the first-clip reach-back work exactly as for audio,
  and the write head advances by heard samples so stop boundaries and
  commit snapping are shared. Render slices the folded cycle window into
  a preallocated per-block `MidiBuffer` (sample-accurate offsets, the
  audio path's run split) and runs the chain ONCE over silence from the
  instrument down; **any content discontinuity** (loop seam, map seam,
  one-shot rest, transport stop, duration truncation) releases the
  notes the content had sounding (`HeldNotes`) — the "hanging notes
  closed at the seam" rule, general. Mute is the ramped PRE-FX gate
  (S7, 2026-08-20 — output-stage gain 0 when this shipped): either way
  a silenced MIDI clip keeps feeding its instrument (unmute resumes
  mid-phrase, nothing hangs). Live play-through and content
  share the one chain run; a release tail (4 s) keeps the chain running
  after the last event so envelopes ring out. Record on a MIDI track
  auto-MIDI-arms it (`AudioEngine::startRecordingInNode`). Waveform
  peaks for a MIDI take are a velocity envelope (note bars in the
  existing lane renderer — the piano-roll view stays phase 6).
  Persistence: `contentKind:"midi"` + inline `midi:[[num,den,byte…],…]`
  (base-relative like the WAV path); no WAV. Multi-segment lock-collapse
  splices the sequence too (`spliceMidiToMap`, `Edit::midi`).
  *Tests:* tests/midi_record_tests.cc — timestamped drain, history
  ring, node-level take (capture → commit → sample-accurate render, seam
  release, stop release, mute-feeds), latency-compensated history
  capture, through-map fold, engine record path + save/load, QTime
  round-trip. The stub synth became sample-accurate for these.
  Known limits (phase 6): SysEx still ignored; a note held ACROSS the
  take's start boundary is dropped (its note-on precedes the take).
- **Phase 6 — polish.** All-notes-off on stop/mute/solo-silence
  (sound-off to the instrument, not just event starvation), instrument
  state in the take undo entries, MIDI clip visualization (piano-roll-ish
  lane rendering in the existing canvas renderer), and the deferred
  hosting items (PDC ruling Q-V2, out-of-process scanning, AU).

Open items specific to instruments are Q-V3/Q-V4 in §9 — they need
rulings before phase 5, not before phase 1.

## 9. Open design questions — ALL RULED 2026-08-15

| # | Question | Ruling (2026-08-15) |
|---|---|---|
| Q-V1 | Mono nodes × stereo plugins: promote-at-first-VST3-slot (§3.3) vs. forcing whole fx path stereo always | **RULED: promote at first VST3 slot** (default accepted). Pan consistency confirmed — see §3.3, pan applies post-chain per channel, so promotion is transparent to it |
| Q-V2 | PDC in a cyclic kernel: plugin latency delays a loop's content *within its cycle* — classic delay-everyone-else PDC fights the island clock. | **RULED: don't worry about it for now.** Metadata latency readout stays (near-free, tells the user when a plugin buffers); compensation deferred indefinitely. The read-ahead sketch stays on file for whenever it matters |
| Q-V3 | Where instruments attach: dedicated MidiClipNode (proposed) vs. instrument-on-stack ("track synth" model) | **RULED: MidiClipNode** — MIDI has genuinely different affordances (e.g. a post-hoc performance editor later); a stack instrument fed by note clips is a later composition. *Phase-5 note (2026-08-18): realized as a CONTENT KIND on ClipNode rather than a second class — the affordances still key on the kind (`contentKind`), and the take lifecycle is shared by construction instead of duplicated; see §8.* |
| Q-V4 | Note storage frame: samples (like audio content) vs. QTime rationals (musical facts, Q12 ruling) | **RULED: default accepted** — samples in the engine content buffer, QTime in the save format (mirrors audio duration/origin, qSamples exchange rate) |
| Q-V5 | Should `CelestrianTests` link the VST3 hosting code? | **RULED: default accepted** — yes, with in-tree stub `AudioPluginInstance` slots; no real plugin binaries in tests |

## 10. Phase plan

Each phase leaves the build green and shippable; tests named per phase.
Status: **phases 1–5 landed** (1–4 on 2026-08-15, all three test layers
green including REAL-BINARY hosting validation via the in-repo test
plugin; 5 on 2026-08-18 — see §8); phase 6 (polish) is next.

1. **Hosting foundation.** ✅ DONE 2026-08-15.
    CMake: `JUCE_PLUGINHOST_VST3=1` on Celestrian
   *and* CelestrianTests (juce_audio_processors is already linked into the
   app target; the tests target gains it). PluginHostService: format
   manager, KnownPluginList + XML persistence, background scan with
   dead-man's-pedal blacklist. Bridge: `getKnownPlugins`, `scanPlugins`.
   UI: plugin list in a settings-ish panel (no chain integration yet).
   *Tests:* list persistence round-trip, pedal blacklist logic.
2. **Dynamic chain refactor (no VST3 in the chain yet).** ✅ DONE
   2026-08-15 — `dsp::FxChain`/`FxSlot` (fx_chain.h; EffectRack deleted,
   the four DSP classes untouched), scope split into a stable per-node
   `FxScope`, `Edit::Kind::MoveSlot` undoable reorder, chain-array save
   format, slot-uuid bridge (setSlotEnabled/setSlotParam/moveChainSlot),
   fx panel patched from the chain (cards follow chain order).
    `FxChain` with
   built-in slots, atomic publish + reclaimer retirement, default
   four-slot chain, array save format (no legacy loader — ruled
   2026-08-15), slot-uuid bridge methods replacing the type-id ones (UI
   migrated in the same change), dynamic effects bar. The
   audible-behavior bar: every existing effects/session test green
   (updated only where they speak the old bridge/save surface), plus new
   chain-order and reorder-preserves-DSP-state tests, save-format
   round-trip.
3. **VST3 effect slots.** ✅ DONE 2026-08-15 — `dsp::Vst3Slot`
   (live + placeholder modes in one class), FxChain::run with the Q-V1
   promotion (internal fold-back for mono-device callers),
   Edit::AddSlot/RemoveSlot (undo entries own the plugin instance;
   retired through the reclaimer grace), async instantiation +
   load-time revival sweep in MainComponent (the engine's ONE
   post-load hook), PluginEditorWindows (native floating windows;
   GenericAudioProcessorEditor fallback), chain-array save format with
   base64 state (save-time only — never in the 20 Hz poll), fx-bar
   chips + picker. **Owner addition (2026-08-15): the in-repo test
   plugin** — test_plugin/ "Celestrian Test Gain" (gain ×0.5 default,
   64-sample REPORTED latency on purpose, 4-byte state; the
   real-binary twin of tests/stub_plugin_instance.h), built behind
   CELESTRIAN_BUILD_TEST_PLUGIN=ON and hosted end-to-end by
   tests/plugin_host_integration_tests.cc (scan thread → pedal-clean →
   instantiate → process → promote → state round-trip, all against the
   actual .vst3). Field note pinned by that test: a PluginDescription
   refilled from a HOSTED instance drops the format tag — slot
   identity must come from the registry description, or revival
   matching breaks.
   Still manual on macOS: real third-party plugins + editor windows.
4. **MIDI input + live play-through** (§8). *Tests:* FIFO timestamping
   against the input clock, all-notes-off on device stop.
5. **Note clips + recording** (§8). ✅ DONE 2026-08-18 — MIDI takes on
   ClipNode (content kind), arrival-history capture, sample-accurate
   note render with seam releases, QTime persistence; tests in
   tests/midi_record_tests.cc (block slicing, lifecycle reuse, seam
   note-off, latency compensation, through-map fold, save/load).
6. **Polish** (§8) + revisit Q-V2 with real-world latency numbers.

Phase 2 is the risk concentrator — it touches every node's render path —
which is exactly why it ships *without* any VST3 code in the chain: the
refactor is verified against unchanged audible behavior before third-party
code enters the picture.

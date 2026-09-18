# Plugin Hosting: VST3/AU Effects & Instruments

> Status: **spec — shipped.** Effects hosting, the dynamic chain, native
> editor windows, out-of-process scanning, MIDI input, note clips, and
> the sound-off/undo/lane-rendering polish are all in code. Plugin delay
> compensation is deferred by ruling (Q-V2). Index: docs/README.md.
>
> §11 records the designs that were tried and rejected. It is the only
> backward-looking section; §1–§10 state present law.

This doc defines the hosting architecture, the audio-thread discipline for
plugin processing, the persistence format, the UI/bridge surface, and what
pins it. It cites performance.md §1 (project law), the D4 atomic-pointer
discipline, and kernel.md's content-agnostic timing facts rather than
restating them.

**Contents**

1. [Goals & non-goals](#1-goals--non-goals)
2. [Constraints](#2-constraints)
3. [The chain model](#3-the-chain-model)
4. [The hosting layer](#4-the-hosting-layer)
5. [Editor windows](#5-editor-windows)
6. [Persistence](#6-persistence)
7. [Bridge & UI surface](#7-bridge--ui-surface)
8. [Instruments & MIDI](#8-instruments--midi)
9. [Rulings (Q-V1–Q-V5)](#9-rulings-q-v1q-v5)
10. [What pins it](#10-what-pins-it)
11. [Appendix — alternatives considered and rejected](#11-appendix--alternatives-considered-and-rejected)

---

## 1. Goals & non-goals

**Goals.** Host third-party VST3 and AudioUnit **effects** as insert slots
on any node — clip or stack, so the fx path stays fractal; run the
built-ins and plugins as peer slots in one dynamic per-node chain; open
each plugin's own editor in a native window; persist plugin state through
save/load including graceful missing-plugin round-trip; and host
**instruments** fed by MIDI input and note clips on the same chain
machinery.

**Non-goals.** Parameter automation lanes (plugins manage their own
parameters through their editors), sidechain routing, VST2/LADSPA formats,
plugin sandboxing for *processing* (crash protection during **scanning**
is in scope — §4), and plugin delay compensation beyond latency
*reporting* (Q-V2).

---

## 2. Constraints

Everything reachable from the device callback obeys the audio-thread
contract (performance.md §1: no locks, no allocation, no I/O, one
structure load per callback, retirement through the reclaimer). Render is
CONST with sanctioned mutable DSP scratch. The chain is published like the
D4 content buffer — one atomic pointer, message-thread swaps, reclaimer
retirement, audio thread loads once per block.

One honest caveat, stated once: `processBlock` of a third-party plugin is
code we do not control. A badly written plugin can allocate or lock on the
audio thread. Every DAW lives with this; our contract governs *our* code —
we prepare plugins off-thread, never instantiate or destroy them on the
audio thread, and never let chain *structure* operations touch the
callback.

**Licensing.** JUCE bundles the VST3 SDK headers
(`juce_audio_processors` hosting support); the VST3 SDK is dual-licensed
Steinberg / **GPLv3**, so the GPLv3 option combines with this project's
AGPLv3 exactly as the ASIO SDK does (see the CMakeLists ASIO comment for
the §13 mutual-permission reasoning). No extra SDK download is needed.

---

## 3. The chain model

### 3.1 Slots

`dsp::FxChain` (`src/dsp/fx_chain.h`) is an ordered vector of **slots**; a
slot is one of:

- **Built-in** — owns one of the `FxEQ` / `FxCompressor` / `FxEcho` /
  `FxReverb` objects. Type ids are `"eq"`, `"compressor"`, `"echo"`,
  `"reverb"` — the ONE list the bridge, metadata, and save format key on.
- **Plugin** — `dsp::Vst3Slot` owns a `juce::AudioPluginInstance` plus its
  identity (plugin uid, `fileOrIdentifier`, `format`), an atomic enabled
  flag, and the last-known state blob for missing-plugin round-trip (§6).
  Live and placeholder modes are the same class.
- **Instrument** — a plugin instrument at the chain head of a MIDI clip:
  same slot machinery, different I/O shape (§8).

Every slot carries a stable slot uuid (`juce::Uuid` at creation,
persisted), so the bridge and UI address slots independently of position
across reorders. A fresh node's default chain is the four built-ins in
canonical order, all disabled.

**Instruments are the head, enforced.** `FxChain::makeFromSlots`
stable-partitions instruments first on every build, so the UI's append
(index −1) and older saves both land the synth ahead of the rack.
Otherwise a MIDI track's built-ins run on the silence *upstream* of the
synth and are then overwritten — the rack does nothing.

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
slot objects shared by predecessor and successor chains. Dial drags never
republish.

`prepare()` runs on the message thread before a slot can be enabled or a
chain published. For plugin slots that means `setRateAndBufferSizeDetails`
+ `prepareToPlay(rate, maxBlock)` with the device's maximum block size
(cached in `audioDeviceAboutToStart` alongside the rate); processing
shorter blocks than prepared is legal. A device rate/block change
re-prepares every chain on the message thread before audio restarts.

### 3.3 The audio-thread process path

The chain keeps the rack's call shape, so `clip_node.cc` and
`stack_node.cc` stay simple: `chain->process(l, n)` and
`chain->processStereo(l, r, n)`, in-place, no-op when nothing is live.
Each enabled slot runs in order; a plugin slot wraps the channel pointers
in a preallocated-header `juce::AudioBuffer<float>` (the
pointer-referencing constructor — no copies, no allocation) and calls
`processBlock` with an empty preallocated MidiBuffer.

**Channel shape.** Plugin effect slots are always instantiated and
prepared **stereo (2 in / 2 out)** — the overwhelmingly supported layout.
On a node whose fx path is running mono (`process`), the chain **promotes
to stereo at the first enabled plugin slot**: the mono signal is copied
into a preallocated right-channel scratch inside the chain, both channels
run from there on, and the node's render path treats the fx output as
stereo from that point. Built-in slots after the promotion use their
existing stereo paths. A chain with no enabled plugin slots behaves
exactly as the mono rack does.

**Pan is unaffected by promotion.** Pan applies AFTER the chain at the
output stage, per channel under the balance law (`outputStageGains`). A
mono signal duplicated to L/R and then panned is bit-identical to the mono
path, which multiplies the same mono buffer by `gl` into left and `gr`
into right — the output stage already *is* pan-by-gain on the promoted
pair.

The scope capture (pre-rack telemetry ring) lives on the chain, capturing
pre-chain, gated on the panel being open.

### 3.4 Latency

`FxChain::totalLatencySamples()` sums the enabled slots'
`getLatencySamples()` (built-ins report 0), recomputed on the message
thread at publish/enable time into an atomic and published in node
metadata for the UI ("⚠ 512 smp" on the effects bar). **There is no
compensation** — Q-V2 (§9).

---

## 4. The hosting layer

`PluginHostService` is a message-thread-only service:

- `juce::AudioPluginFormatManager` with `VST3PluginFormat` registered, and
  `AudioUnitPluginFormat` on Apple (`JUCE_PLUGINHOST_AU=1`, both targets).
  Registry entries and slot metadata carry `format` (persisted; absent
  means VST3). AUs join default-location scans only.
- `juce::KnownPluginList`, persisted as XML in the app data dir
  (`userApplicationDataDirectory/Celestrian/known_plugins.xml`).
- Scanning covers the platform default plugin directories plus a
  user-added path (`startScan(path, include_default_locations)`; tests
  confine themselves to one folder). Progress and results reach the UI
  through the status poll.
- Instantiation is `createPluginInstanceAsync` on the message thread; the
  completion lambda builds the slot, prepares it, and publishes the
  successor chain (§3.2). The UI shows the slot as "loading" from the
  optimistic add until the publish event.

### Out-of-process scanning

**The app process never loads plugin code during a scan, and the worker is
the only probe path.** `PluginHostService` (the coordinator, on a
background thread) enumerates candidate files itself — directory walking
only — drops the ones already listed or blacklisted, and re-launches **its
own executable** as `Celestrian --scan-worker <list> <results>`
(`src/plugin_scan_worker.h`; the same flag lives in `CelestrianTests`, so
tests exercise the real machinery on their own binary).

The worker probes each file and appends `BEGIN\t<file>`,
`FOUND\t<base64 PluginDescription xml>`, `END\t<file>`, `DONE` lines to
the results file, flushing after every line. The coordinator tails the
file every 100 ms and watches the child's liveness:

| Failure | Coordinator's response |
|---|---|
| Plugin **crashes** | BEGIN with no END → blacklist that file, start a fresh worker on the remainder |
| Plugin **hangs** | file silent past the probe timeout (60 s) → kill the worker, treat the file the same |
| Worker exits having probed nothing | end the scan with `error`; blame no plugin, never respawn forever |
| No worker command configured | a scan with anything to probe ends with `error` and loads nothing |

Results go through a file, not a pipe, precisely so the coordinator can
poll with a timeout instead of sitting in a blocking read. The worker
installs crash-signal handlers that `_Exit(128+sig)` — no "quit
unexpectedly" dialog per bad plugin on macOS — and `juce::ChildProcess`
reports exit code 0 for a signal-killed child anyway, so liveness plus the
results file are the evidence, never the exit code. On macOS the worker
hides its dock icon; it sets up no logger (it would wipe the parent's) and
no window.

The status var carries `crashed` (file names excluded this scan),
`crashedCount`, `error`, and `outOfProcess`; the plugin panel names the
excluded plugins in its scan-done line. There is no dead-man's-pedal file.

> **Field notes.** A JUCE 8 scan never even loads a bundle that ships
> `moduleinfo.json` — descriptions come from the manifest — so the plugins
> that can crash a scan are the ones without a manifest, or ones that die
> on library load. And a `PluginDescription` refilled from a HOSTED
> instance drops the format tag: slot identity must come from the registry
> description, or revival matching breaks.

---

## 5. Editor windows

Plugin editors are native views and the main UI is a webview, so editors
live in **floating native windows**. One
`PluginEditorWindow : juce::DocumentWindow` per open slot owns
`plugin->createEditorIfNeeded()`; close deletes the editor, never the
instance, and reopening recreates it. Windows are message-thread objects
keyed by slot uuid in `PluginHostService`; closing a node or slot closes
its window first — editor before instance, always.

Plugins without an editor get JUCE's `GenericAudioProcessorEditor` in the
same window. The web UI has no generic parameter panel; the built-ins keep
their own web panel via `effect_schema.js`.

---

## 6. Persistence

The per-node `effects` blob is an **array** in chain order, each entry
`{slot: <uuid>, type: <id>, enabled: <bool>, …}`:

- **Built-in:** `type` is the canonical id, params inline —
  `{type:"echo", enabled:true, time:0.35, …}`.
- **Plugin:** `{type:"vst3", uid, name, fileOrIdentifier, format,
  state:<base64>}`, where `state` is `getStateInformation`'s MemoryBlock,
  refreshed at save time on the message thread (never in the 20 Hz poll).

**There is no legacy loader.** The loader reads the array form only; a
legacy `effects`-object blob encountered on load is ignored — the node
gets the default chain — rather than erroring the whole session load.

**Missing plugin on load.** The slot is created as a *placeholder*: no
instance, the audio path a hard bypass, a "missing" badge in the UI. It
keeps `uid` / `fileOrIdentifier` / `format` / `state` verbatim, so
save → load → save never sheds a plugin the user merely hasn't installed
on this machine. If a scan later finds it, the placeholder is revived in
place — publish a successor chain with a live slot restored from the kept
state.

**Undo.** Chain *structure* edits (add / remove / move slot) are undoable
Edit events (`Edit::Kind::MoveSlot`, `AddSlot`, `RemoveSlot`); enable flips
and parameter changes are not — the same dial-drag-flooding reasoning as
pan and gain. A removed slot's plugin instance is owned by the undo entry
like a displaced content buffer, never freed inline; the redo-branch
invalidation frees it through the reclaimer.

---

## 7. Bridge & UI surface

Bridge methods (webview native functions, same adapters as the rest):
`getKnownPlugins()`, `scanPlugins(paths?)`, `addPluginSlotToChain(nodeUuid,
pluginUid, index)` (`addVst3SlotToChain` aliases it),
`removeChainSlot(nodeUuid, slotUuid)`, `moveChainSlot(nodeUuid, slotUuid,
newIndex)`, `openPluginEditor(nodeUuid, slotUuid)`,
`setSlotEnabled(nodeUuid, slotUuid, on)`, and `setSlotParam(nodeUuid,
slotUuid, key, value)`. Addressing is **by slot uuid throughout**.
Parameters remain built-in-only — plugin parameters belong to their
editors.

**Effects bar** (session_view.md): renders the chain array from node
metadata in order — built-ins with their mini-panels
(`effect_schema.js`), plugin slots as named chips with enable toggle and
missing/loading badges, click-to-open-editor, and a "+" chip opening the
picker fed by `getKnownPlugins`. Reorder by drag within the bar. Latency
badge when `totalLatencySamples > 0`.

---

## 8. Instruments & MIDI

The kernel is content-agnostic — origin/period/quantum/launch are facts
about *time*, not audio buffers (kernel.md) — so a note clip slots into the
timing model unchanged. What is new is capture, storage, and rendering.

### 8.1 MIDI input and live play-through

`MidiInputQueue` is a lock-free SPSC ring (channel messages only,
drop-and-count overflow). The engine is the all-devices
`MidiInputCallback`; device enabling happens in the APP shell at startup
and heartbeat, so headless tests stay device-free. One drain per callback
fills a preallocated MidiBuffer riding `ProcessContext.live_midi`.

Instrument slots are `Vst3Slot(is_instrument)`: prepared 0-in/2-out, they
consume MIDI via `FxSlot::processStereoMidi` and **overwrite** the buffer —
the chain-head generate semantic. The flag rides add/save/revive.

**The MIDI target follows selection.** `app.js syncMidiTarget` reconciles
`setMidiArmed` to the most recently selected instrument lane every poll, a
MIDI take in progress winning. `AudioNode::midi_armed` is single-armed via
`setMidiArmed` — a monitoring gesture like solo: not undoable, not
persisted. The MIDI chip on the rail lights ♪ for the current target.

The armed node hands the block's events to its fx pass. A clip with no
content or transport renders a silence pass through the chain — the
play-through tail, never a SECOND chain run in one block; stacks get it
free via their every-block fx pass. `getMidiInputs` exposes diagnostics.

### 8.2 Note clips and recording

**Content kind, not a second class.** `ClipNode` carries
`ContentKind::{Audio, Midi}` (`midi_sequence.h`). The take lifecycle —
arm → capture → stop → commit, quantum snapping, through-map fold, zero
re-base, undo entries — is content-agnostic and lives in ClipNode, so a
MIDI take reuses it *verbatim*; only ingest and render differ
(`captureMidiBlock`, `renderMidi`).

The kind is decided AT ARM from the clip's own chain — an instrument slot
means a MIDI track (`hasInstrumentSlot`) — and fixed for the take. UI
affordances key on the published `contentKind`, which is also `"midi"` for
an empty clip with an instrument: its next take records notes, and the
rail shows a ♪ MIDI chip where the audio-input picker was, since a note
take has no audio input.

**Content.** A fixed-capacity `MidiSequence` of POD events
`{pos, bytes, size}` in the origin frame — samples in the engine, QTime in
the save format (Q-V4) — reached through one atomic pointer, D4 verbatim;
arm-time reservation, drop-and-count at the wall.

**Capture** is the note twin of the pre-record ring. The engine drains the
FIFO by **arrival timestamp** (sub-block offsets, the
`MidiMessageCollector` rule) into an input-clock-indexed `MidiHistory`
ring; a recording clip reads its window from it:

```text
content 0  ↔  arrival(target + midi_lat)
```

`midi_lat` is OUTPUT latency only — a key pressed on the heard beat has no
input-side device delay (`ProcessContext.midi_latency`, the
driver-reported output figure or half the measured round trip). So the
pickup and the first-clip reach-back work exactly as for audio, and the
write head advances by heard samples, so stop boundaries and commit
snapping are shared.

**Render** slices the folded cycle window into a preallocated per-block
`MidiBuffer` (sample-accurate offsets, the audio path's run split) and
runs the chain ONCE over silence from the instrument down. Live
play-through and content share that one chain run. A release tail (4 s)
keeps the chain running after the last event so envelopes ring out.

**Mute** is the ramped PRE-FX gate (S7): a silenced MIDI clip keeps
feeding its instrument, so unmute resumes mid-phrase and nothing hangs.
Record on a MIDI track auto-MIDI-arms it
(`AudioEngine::startRecordingInNode`).

**Waveform peaks** for a MIDI take are a velocity envelope.
**Persistence** is `contentKind:"midi"` plus inline
`midi:[[num,den,byte…],…]`, base-relative like the WAV path; no WAV.
Multi-segment lock-collapse splices the sequence too (`spliceMidiToMap`,
`Edit::midi`).

### 8.3 Sound-off edges

**Any content discontinuity releases the notes the content had sounding**
(`HeldNotes`) — loop seam, map seam, one-shot rest, transport stop,
duration truncation. This is the general "hanging notes closed at the
seam" rule.

When a MIDI clip's content stops sounding — transport stop, the S7 gate
landing closed (mute, solo-silence, a sequence cut), the new-take silence,
a bounce tail, or a device stop (`requestMidiSoundOff`, walked from
`audioDeviceStopped`) — the instrument gets the held notes' note-offs plus
CC 123 and CC 120 on the channels in use, **once per closing edge**, never
per block (`renderMidi`'s `closingEdge`). The gate edge lands where the
ramp reaches zero, so there is no pop; a muted instrument keeps being fed.

### 8.4 Boundary notes and undo

- A note down before the capture window opens lands as a note-on at
  content 0 (I1, the prelude); one still down at commit is closed at the
  last sample.
- A MIDI take's `TakePayload` carries the instrument slot's uuid and state
  blob at commit. Take/Untake restore it, the inverse capturing the state
  current then (copy-swap).

### 8.5 MIDI lane rendering

A MIDI lane's tiles paint note bars from `getMidiNotes` (fetched on
demand, cached by `midiEvents` plus active take): pitch → row over a
compact range fit, length → width, velocity → alpha, sliced per rep tile
by the audio tile's `srcSegs`/rotation rules so windows, cuts, and comps
apply (`ui/js/midi_notes.js`, `canvas_renderer.drawMidiTile`).

### 8.6 Known limits

SysEx is ignored. A note held ACROSS a take's start boundary whose note-on
precedes the take is dropped.

---

## 9. Rulings (Q-V1–Q-V5)

Recorded 2026-08-15; indexed in design_language.md §5.

| # | Question | Ruling |
|---|---|---|
| Q-V1 | Mono nodes × stereo plugins: promote at the first plugin slot, or force the whole fx path stereo always? | **Promote at the first plugin slot** (§3.3). Pan consistency confirmed: pan applies post-chain per channel, so promotion is transparent to it. |
| Q-V2 | PDC in a cyclic kernel — plugin latency delays a loop's content *within its cycle*, so classic delay-everyone-else PDC fights the island clock. | **Don't worry about it for now.** Metadata latency readout stays (near-free; it tells the user when a plugin buffers); compensation deferred indefinitely. The read-ahead sketch — read-ahead, not delay-others — stays on file for whenever it matters. |
| Q-V3 | Where instruments attach: a dedicated MIDI clip node, or an instrument on the stack ("track synth")? | **A MIDI clip**, not a track synth — MIDI has genuinely different affordances (a post-hoc performance editor later); a stack instrument fed by note clips is a later composition. Realized as a content KIND on `ClipNode` rather than a second class (§8.2, §11). |
| Q-V4 | Note storage frame: samples like audio content, or QTime rationals (Q12)? | **Samples in the engine content buffer, QTime in the save format** — mirrors audio duration/origin and the qSamples exchange rate. |
| Q-V5 | Should `CelestrianTests` link the hosting code? | **Yes**, with in-tree stub `AudioPluginInstance` slots; no real plugin binaries required in the unit tests. |

---

## 10. What pins it

### The in-repo test plugins

Real binaries, built behind `CELESTRIAN_BUILD_TEST_PLUGIN=ON`:

- **"Celestrian Test Gain"** (`test_plugin/test_gain_plugin.cc`) — gain
  ×0.5 default, 64-sample REPORTED latency on purpose, 4-byte state. The
  real-binary twin of `tests/stub_plugin_instance.h`.
- **"Celestrian Test Crash"** (`test_plugin/test_crash_plugin.cc`) — takes
  a real invalid memory access the instant a host probes it. Built
  *without* a `moduleinfo.json` (`VST3_AUTO_MANIFEST FALSE`), or the scan
  would never load it and the manifest generator itself would die.

### Tests

| Area | Tests |
|---|---|
| Hosting end-to-end, real binary | `tests/plugin_host_integration_tests.cc` — scan thread → pedal-clean → instantiate → process → promote → state round-trip, against the actual `.vst3` |
| Scan crash/hang survival | `tests/plugin_scan_crash_tests.cc` — scans a temp folder holding Test Crash **and** Test Gain from the test process through the ordinary `startScan`. *The suite surviving is the headline.* Then: Test Gain found; Test Crash excluded, blacklisted, and named in `crashed`; registry persisted; a rescan launches no worker and keeps the exclusion; a HUNG probe (worker hook `CELESTRIAN_SCAN_WORKER_HANG_ON`, 2 s timeout) killed and excluded alongside the crasher; a worker that cannot launch ends the scan with `error` and blames no plugin. The worker protocol is pinned directly (`probeFiles` on Test Gain → BEGIN/FOUND/END/DONE, FOUND decoding to its description) |
| Hosting without real binaries | `tests/plugin_host_tests.cc` — registry persistence, the confined-scan switch |
| Chain | chain-order and reorder-preserves-DSP-state tests, save-format round-trip |
| MIDI takes | `tests/midi_record_tests.cc` — timestamped drain, history ring, node-level take (capture → commit → sample-accurate render, seam release, stop release, mute-feeds), latency-compensated capture, through-map fold, engine record path, save/load, QTime round-trip |
| Note releases | `tests/midi_release_tests.cc` |
| Take undo with instrument state | `tests/take_undo_tests.cc` |
| MIDI lane UI | `ui/js/tests/midi_lane.test.mjs`, `ui/e2e/midi_lane.spec.js` |

Still manual on macOS: real third-party plugins and their editor windows.

---

## 11. Appendix — alternatives considered and rejected

Kept so they are not re-proposed.

**The fixed `EffectRack`.** Four fixed slots (EQ → Compressor → Echo →
Reverb) per node, addressed by type id across bridge, metadata, and save
format. **Replaced** by the dynamic `FxChain` so built-ins and plugins
could be peer slots — the outcome `dsp/effects.h` anticipated: "the
dynamic-chain complexity arrives with VST3, which will replace the rack's
internals, not its bridge surface." The four DSP classes themselves were
untouched by the change. *`EffectRack` no longer exists in `src/`.*

**Type-id slot addressing** (`setEffectEnabled` / `setEffectParam` keyed
by `"echo"` etc.) and a **compatibility shim** to keep it alive alongside
uuid addressing. **Rejected** with the no-back-compat ruling — owner: "you
really don't have to worry about existing sessions, I don't have anything
that needs to be salvaged." The bridge moved wholly to slot-uuid
addressing and the UI migrated in the same change.

**The legacy `effects`-object loader.** Replaying the old object form on
load. **Not built**, same ruling. A legacy blob is ignored and the node
gets the default chain.

**Forcing the whole fx path stereo always** (Q-V1's alternative).
**Rejected** in favour of promoting at the first enabled plugin slot, so a
chain with no plugins is bit-identical to the mono path.

**Classic delay-everyone-else PDC** (Q-V2). **Deferred indefinitely:** in
a cyclic kernel, plugin latency delays a loop's content *within its
cycle*, so compensating by delaying everyone else fights the island clock.
The direction on file is read-ahead, not delay-others. Latency
*reporting* stays because it is near-free.

**The instrument-on-stack "track synth" model** (Q-V3's alternative) — an
instrument living on a stack, fed by note clips beneath it. **Rejected:**
MIDI has genuinely different affordances, and a stack instrument fed by
note clips is a later composition on top of the clip model, not a
replacement for it.

**A separate `MidiClipNode` class** — the literal form of the Q-V3 ruling.
**Superseded at build time** by a content KIND on `ClipNode`: the take
lifecycle is content-agnostic, so a second class would have duplicated
arm/capture/stop/commit, quantum snapping, through-map fold and undo
rather than reusing them. The affordances still key on the kind
(`contentKind`), which was the ruling's actual intent.

**The ♪ rail toggle** — an explicit per-track MIDI monitoring arm.
**Retired 2026-08-18**, owner: "it should just always be monitoring if
it's selected." The MIDI target now follows selection (§8.1).

**A generic parameter panel in the web UI** for plugins without an editor.
**Rejected** with the native-window ruling; those plugins get JUCE's
`GenericAudioProcessorEditor` in the same floating window.

**In-process plugin scanning**, with a dead-man's-pedal file to recover
from a crash mid-probe. **Replaced** by out-of-process scanning (§4): the
worker is now the only probe path, there is no in-process fallback, and
the pedal file is gone. A crash takes down only the worker.

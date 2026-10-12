# UI/Backend Separation of Concerns

> Status: **spec**. The canonical bridge method list lives in
> `ui/js/protocol.js` (contract-tested against C++ and the mock); this
> doc owns the *placement rules* for what belongs on which side.

This document defines the abstraction boundary between the Celestrian frontend (JavaScript) and backend (C++).

## Principles

### Backend Responsibilities (C++)

- Audio processing and playback
- Recording and buffer management
- Transport state (samples, not pixels)
- Node graph structure (ordered lists, not positions)
- Loop points (in samples)
- Persistence-worthy state

### The masterPos contract

`getGraphState().masterPos` is a **derived display position**, never the
raw monotonic clock (kernel.md step 3): wrapped to the cycle while
idle/playing, and **growing linearly past the committed LCM while
recording**, so the cursor extends into new Qs. Consumers must not
re-wrap it — re-deriving with `mod cycle` in the UI caused the
"recording loops the old cycle" field bug (2026-07-09). While a take is
live it reads one of two ways:

- **With Q** — a base frozen as the take begins, plus the clock since.
  The base is the block's place in the audible cycle, folded from the
  root's frame top with `posMod`: a place IN the cycle even when the
  clock stands before that top (a take armed after a backward seek
  never reads a negative cursor).
- **Before Q — the island's first take** — the first take's OWN
  position: the clock read from the island zero its arm block stores,
  `masterPos = clock − zero`. Whatever the clock read when the take was
  armed (the transport ran first, the island was emptied and recorded
  again), the cursor starts at the take's top. With a round-trip
  latency L the take's top is L before the arm, so the cursor leads the
  captured length by L — the same relation every later take has (the
  bar trails the cursor by the monitoring delay).

The mock mirrors this contract exactly (`mock/transport.js`
`viewMasterPos`), and the differential holds it there
(test_harness.md). Similarly, a recording clip's `duration` is the
live written length, 0 while pending start.

### The answer law

Every bridge verb answers in one of three KINDS, declared once in
`ui/js/protocol.js` (`returns`) and held to it on both backends by
`protocol_contract.test.mjs`:

- **A verb that can be refused answers whether it applied.** `true`: it
  did what it says. `false`: it was REFUSED and nothing changed — the
  live-take gate, an unknown node, an incoherent map, a full take list.
- **An edit that would change nothing is not applied**: renaming a node
  to the name it has, moving it to the slot it is in, setting the input
  it has, the song it holds, the comp it has, selecting the active
  take. It records NO undo step, keeps the redo branch, and answers
  `false`. (The shell does not send such an edit, so nobody is told a
  click "was refused" for asking what is already so.)
- **A query answers its value**; the listings (`getProjectInfo`,
  `listTemplates`, `listRecentProjects`, `listTrackTemplates`) answer
  records and arrays, not JSON text. The two verbs that make a node —
  `createNode`, `combineNodes` — answer the new node's uuid, `""` when
  refused.
- **A knob or a notification nothing can refuse** (gain, pan, solo, a
  slot's parameter) answers `true` once it ran.
- A call the bridge LOST answers `null`, whatever its kind.

**The status line reads the answer.** In the shell every user verb is
one `call(method, args, okMsg, failMsg)` (`ui/js/shell_io.js`): the
line is chosen AFTER the answer — `okMsg` when it applied, `failMsg`
when it was refused, "The engine did not answer — nothing changed" when
the call was lost — and never written ahead of it. The reason a refusal
gives ("a take is live") is read from the graph as it is at the
refusal, not from a poll that may be a take old. A verb made of several
calls is `callEach(steps, okMsg, failMsg)`: THE FIRST REFUSAL ENDS THE
SEQUENCE, so no later step runs on a graph the earlier one did not
leave (an ungroup whose members would not move never deletes the
shell), and the line says how far it got. The lane's own verbs —
delete, rename, the takes and the comp, the song, input and
monitoring, the rack, undo and redo — are `ui/js/lane_verbs.js`.
A geometry drag streams live commits, so its line is the debounced
VERDICT on the published graph (`ui/js/edit_verdict.js`), not one
commit's answer.

### Frontend Responsibilities (JavaScript)

- Visual layout and rendering
- Pixel positions and dimensions
- Drag & drop interactions
- User input handling
- Converting backend state to visual representation

---

## API Operations

### ✅ Correctly Placed

| Operation | Params | Notes |
|-----------|--------|-------|
| `togglePlayback` | none | Pure backend state |
| `seekTransport` | deltaSamples, atClock? | Ruler scrub (2026-08-27; frame.md 2026-09-17): a phase ADVANCE the view computes against the frame zero it seated, corrected by the engine for the clock since `atClock`; refused mid-take; not undoable |
| `startRecordingInNode` | uuid | Pure audio action; answers whether a take was armed (refused under a live take, with no empty clip beneath, or through a map that cannot place it) |
| `stopRecordingInNode` | uuid | Pure audio action; answers false when nothing beneath was armed or capturing |
| `getGraphState` | none | Backend → Frontend data |
| `getWaveform` | uuid, numPeaks | Audio data for visualization |
| `renameNode` | uuid, name | Pure data change |
| `getInputList` | none | Hardware info |
| `setNodeInput` | uuid, channelIndex | Audio config |
| `setLoopPoints` | uuid, startSamples, endSamples | Correctly uses samples |
| `toggleLoopWindow` | uuid | Window activation is data, not view state (time_maps.md) |
| `startLatencyCalibration` / `getLatencyCalibration` | — | Hardware measurement (performance.md §7) |
| `toggleSolo` | uuid | Pure audio state |
| `toggleMute` | uuid | Pure audio state |

### ✅ Previously Abstraction Violations (Resolved)

| Operation | Status | Resolution |
|-----------|--------|------------|
| `createNode` | ✅ Fixed | No x,y params; child nodes append to parent; answers the new node's uuid (`""` refused). (No node position exists in the engine since the session view.) |
| `moveNode` | ✅ Fixed | Replaced with `reorderNode(nodeId, parentId, newIndex)` — frontend calculates index from drop position. |

---

## Detailed fixes

Resolved 2026-07 (P2-9 `backend.js` facade; `moveNode` → `reorderNode`,
`createNode` without x/y). Per-node `togglePlay` was deleted with Q16
(2026-08-13): mute/solo plus the one transport are the per-node play
controls.

## Notes on `setNodePosition`

Gone (A5): no node x/y in the engine, protocol, or session — lane
placement is a UI projection of `origin` (I6), fold state is UI-local
(`ui/js/view_prefs.js`, I6b).

# Takes and comping (B4)

> Status: **shipped** — engine, bridge and mock (tests/takes_tests.cc,
> ui/js/tests/takes_mock.test.mjs) and the UI (§6; ui/js/tests/
> takes_ui.test.mjs, ui/e2e/takes.spec.js). Companions:
> design_language.md Q7/Q13, composition.md §1–§2, sequencer.md §11
> (S19 — takes are undoable), time_maps.md §3 (the one-period cap).

## 1. The model

A committed clip is a **slot**: one origin, one period, and N ≥ 1 **takes**
— alternate content buffers for the same musical slot (take 0 is what a
clip held before). One take is **active** (`content_` points at it); the
rest sit in the clip's list as detached records. The kernel equation is
untouched: the clip reads `content[base + inner(t)]`; only *which* buffer
is read changes. Invariants: **one origin, one period per clip**; **takes
are immutable** (a removed take travels into the edit log and retires
through the reclaimer, never freed inline); **one base per slot** (a
lock-collapse shifts every take by the same shift, a multi-segment collapse
splices every take, so one `content_base_` serves all); **one content kind
per slot**. Bounds: 32 takes per clip, 256 comp cells.

## 2. New take — the arm rule

`newTake(uuid)` on a committed clip — or on a stack, every committed
direct clip child as one performance (Q7-fractal) — arms a further take
**without emptying the slot**: the active content moves into its list
slot and the clip renders **silence** while the take is armed or
capturing (the performer hears the rest of the island). Arm target: the
next `t ≡ origin (mod period)` in the heard frame — the slot's own top,
so the take has the same origin by construction. Capture runs **exactly
one period** and auto-finishes (`capture_cap_`, the through-map cap
mechanism); a stop before that **cancels** the take — nothing shorter can
be a take of the slot — and the previous active take sounds again. At
commit the take is appended and becomes active; origin, duration, base,
loop points and comp are unchanged; the lock-collapse at arm applies as for
any arm. Refused (logged): no committed target; a one-shot; an active
ancestor window or step audition (the slot top may never be heard through
it); a full list; a kind change. `startRecordingInNode` keeps refusing a
committed clip; `newTake` is the sanctioned path.

**A slot being re-taken is still a part of every fold.** From the arm
to the commit the slot keeps its committed period (`prepareRetake`
keeps `duration_samples` and returns what it displaced, for the engine
to retire), and the period law has no "recording"
clause: the slot's period stays in its group's own period, in the
island cycle the transport wraps on and in every scope cycle a one-shot
beside it fires on. Nothing re-aligns when the take starts or when it
commits. A FIRST take is different: it has no committed period, so it
plays nothing and contributes nothing until it commits. The JS twin
(`ui/js/period_law.js`) reads the same two cases off the published
state — a recording clip that publishes a slot period on `periodQ` is a
new take of that slot; one that publishes none is a first take — and
the golden `period_law_cases` pin both sides on a clip that is really
capturing.

## 3. Selection, deletion, comping

- `selectTake(uuid, k)`: an atomic content-pointer swap (`content_` /
  `midi_`; the displaced pointers live on in the list).
- `deleteTake(uuid, k)`: never the last take; an active take hands
  activity to its lower neighbour; comp cells naming it fall back to the
  active take, higher cells renumber.
- `setComp(uuid, cells)`: one take index per Q cell (`ceil(period / Q)`
  cells, −1 = the active take, `[]` clears). The render reads the take table
  once per block (seqlocked, all-atomic, inline — the map's discipline) and
  **cell boundaries are seams**: a run never crosses a cell, so every run
  reads one buffer at `[base + p]`. A new take leaves the comp untouched.
  MIDI clips take and select; comping them is refused. The cell bound is
  judged only for a comp being SET: a clear is always accepted.

**The comp's grid is stored with it** — a cell LENGTH and an OFFSET:
cell k covers the content positions `[offset + k·len, offset + (k+1)·len)`.

- The length is the Q the comp was authored at. It does not follow a
  later change of Q (a hand-off, a definer re-trim): the cells stay
  where they were drawn.
- The offset is 0 as authored. A **lock-collapse** slides it exactly as
  it slides the top (`collapseContent` / `uncollapseContent`), so each
  cell keeps naming the same stretch of the recording; cells the
  collapsed take no longer reaches stay stored, and the re-open brings
  them back.
- A **splice** (the lock-collapse of a cut map) cannot keep one grid:
  it copies what the comp SOUNDED over each kept stretch into the
  active take and clears the comp. The other takes are cut to the same
  cells and stay selectable. The un-splice restores takes, map and comp.

Both are published beside `comp` as `compCellLen` and `compOffset`
(samples; 0 and 0 with no comp). `setComp` always authors on the
current Q grid at offset 0.

**What the verbs answer** (the answer law, ui.md). `newTake`,
`selectTake`, `deleteTake` and `setComp` each answer whether they
applied: `false` for a refusal (the cases above; a take live anywhere
on the island) — nothing changed, nothing logged — and `false` too for
an edit that would change nothing: selecting the take that is already
active, setting the comp the slot already has. Such an identity
records no undo step and keeps the redo branch; the shell does not
send it. `stopRecordingInNode` answers false when nothing beneath was
armed or capturing (recording.md).

## 4. Undo shapes (all refused, entries kept, while any take is live)

| Verb | Edit | Inverse |
|---|---|---|
| new take (settled) | `Untake` + `take_index`, `prev_active` | `Take` re-appends it as active |
| `selectTake` | `SelectTake` (index) | `SelectTake` (old index) |
| `deleteTake` | `DeleteTake` (index) | `DeleteTake` owning the record + old activity + old comp |
| `setComp` | `Comp` (cells, cell length) | `Comp` (old cells, their length and offset) |

A whole-clip `Untake` applies only to a single-take slot: undo removes a
slot's takes one by one and empties the clip last.

**The re-time rider (owner, 2026-09-24; loop_selection.md §9).** A new
take is recorded against the slot's current origin, so it plays exactly
as performed even in a re-timed clip — and it RESETS the clip's
`retime` to 0, so the timing readout and "Timing as played" describe
the newest take; older takes keep their shift as a baked fact. The
settled take's `Untake` carries the retime from before it (`setsRetime`,
like the comp rider): undo gives the old shift back, redo zeroes it
again. An IMPORTED take (import.md, the second form) does not reset it
yet — open.

## 5. Persistence and metadata (additive — absent = one take, no comp)

session_io keys `takes`, `activeTake`, `comp` + `compCellQ`; audio per take
as `<uuid>.wav` (take 0) and `<uuid>.take<k>.wav`; MIDI takes as `midiTakes[k]`.
The comp's OFFSET is not saved: a comp on a lock-collapsed clip reloads at
offset 0 (tasks.md Tier G). A later take whose WAV is missing loads SILENT in
its slot, so `activeTake` and the comp keep naming the takes that were saved.
The mirror treats take files as immutable (length probe); a renumbering delete
rewrites the slot's files and prunes stale ones. Templates strip takes. Metadata
`takes`, `activeTake`, `comp`, `compCellLen`, `compOffset`; `getWaveform` = the
active take, `getTakeWaveform` any.

## 6. The UI

- **● = new take on content** (`armMode`, `ui/js/vm/lane_common.js`:
  stop / record / retake / null for a one-shot). With nothing empty
  beneath, ● on a committed clip — or a group whose committed direct
  clips exist — calls `newTake`; ● again cancels. The lane keeps its
  tiles, `silent` (dimmed) under the live bar, whose length runs from
  the slot top; the arm marker waits at the slot's next top. The view
  knows a new take from the published state alone — a recording clip
  that publishes a slot period (`isRetaking`, `ui/js/vm/published.js`)
  — so a page that first sees a take already running draws it right.
  The app also keeps the ids it saw go hot (`retakes`,
  `content_cache.js`) to seed the take's peaks, and passes them as
  `opts.retakes` for a state that publishes no `periodQ`.
- **A mic of the definer group** (the trim view) shows its take chip
  and a disabled ●: the group is one take, so the mic's ●, chip and
  take list say that the GROUP's ● records another
  (`take_menu.takeVerbOwner`).
- **The published shape of a new take (2026-10-01).** The slot keeps
  its facts, but while the take runs the engine PUBLISHES it this way
  (`AudioNode` / `ClipNode::getMetadata`): pending (`isPendingStart`,
  not `isRecording`) until its top, then `isRecording` with `duration` =
  the LIVE captured length (0, growing to the period) and the slot's own
  length on `periodQ` ({num, den} of Q). The mock publishes the same
  (`mock/publish.js`, at the boundary — its own state keeps
  `isRecording` from the arm and the slot's `duration`): until
  2026-10-01 it published those instead, with no `periodQ`, and the
  view never met the engine's shape in the mock suite. The view model
  reads the slot through one helper, `retakeSlot`, wherever a new take
  must stand as the loop it is re-taking:
  - its lane tiles the slot's period and measures the bar from the slot
    top (`pushRecordingLane`) — read off the live length, the resting
    tiles re-tiled on every poll and the bar jumped about;
  - the cycle keeps it by the period law itself (§2), and the
    growing-frame math grows nothing (`settledForFrame`) — read as a
    fresh take, a new take of the loop that alone made the frame 4Q
    collapsed it to 1Q and regrew it Q by Q;
  - the seat reads its top and period (`seatFrameZero`, frame.md §1) —
    counted as a growing take, a new take of a 1Q loop above the placing
    loop took the frame for as long as it recorded.
  - a GROUP's own lane reads its mics the same way
    (`readGroup` in `ui/js/vm/lanes.js`, through `settledForFrame`):
    read as published, a
    4Q kit re-tiled as four 1Q tiles for as long as its mics captured.
  All four were engine-only (the mock could not show them) and were
  found with the headless engine; pinned by `takes_ui.test.mjs` and
  `frame_seat.test.mjs` (h) on both shapes, and by
  `takes_mock.test.mjs` (h), which runs the mock's own published state
  through the view for a whole group take — armed, capturing,
  committed.
- **The take chip** `T<active+1>/<n>` on the rail head (quiet with one
  take, lit in comp mode) opens the take list under the rail: one row
  per take with its `getTakeWaveform` mini waveform (cached per take;
  a list change drops the cache), the active row ✓, click = `selectTake`,
  × = `deleteTake` (disabled on the last take), a `comp` row. Escape is
  a PANEL-scope binding; outside press dismisses.
- **Comp mode** (view state, `opts.compMode`; a windowed lane opens its
  raw inspector): one `.comp-cell` per Q cell over the take tile; click
  cycles −1 → 0 … → n−1 → −1 (`comp_model.cycleComp`, all-−1 normalizes
  to `[]`) and commits ONE `setComp`. Cells naming another take tint in
  that take's hue with its slice drawn over — at rest too.
- **The lane carries the comp's two grids** (`takeFields`,
  `ui/js/vm/lane_common.js`; laid out by `comp_model.compLayout`):
  `compCells` is the EDITOR's — one cell per Q of the take, what a click
  authors; `compCellQ` / `compOffsetQ` are the grid the comp SOUNDS on,
  from the published `compCellLen` / `compOffset` (§3). At rest the
  tinted cells lie where the engine plays them — a cell length from
  another Q, a grid slid by a lock-collapse, cells the take's ends
  clip. In comp mode on a grid that is not today's Q grid, what sounds
  is drawn as at rest with the editor's cells on top, and a click sends
  the comp RE-READ onto today's grid — each cell names the take
  sounding at its start — with the clicked cell cycled (the engine
  authors every `setComp` on the current grid).

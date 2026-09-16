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
  MIDI clips take and select; comping them is refused.

## 4. Undo shapes (all refused, entries kept, while any take is live)

| Verb | Edit | Inverse |
|---|---|---|
| new take (settled) | `Untake` + `take_index`, `prev_active` | `Take` re-appends it as active |
| `selectTake` | `SelectTake` (index) | `SelectTake` (old index) |
| `deleteTake` | `DeleteTake` (index) | `DeleteTake` owning the record + old activity + old comp |
| `setComp` | `Comp` (cells, cell length) | `Comp` (old cells) |

A whole-clip `Untake` applies only to a single-take slot: undo removes a
slot's takes one by one and empties the clip last.

## 5. Persistence and metadata (additive — absent = one take, no comp)

session_io keys `takes`, `activeTake`, `comp` + `compCellQ`; audio per take
as `<uuid>.wav` (take 0) and `<uuid>.take<k>.wav`; MIDI takes as `midiTakes[k]`.
The mirror treats take files as immutable (length probe); a renumbering delete
rewrites the slot's files and prunes stale ones. Templates strip takes. Metadata
`takes`, `activeTake`, `comp`; `getWaveform` = the active take, `getTakeWaveform` any.

## 6. The UI

- **● = new take on content** (`view_model.armMode`: stop / record /
  retake / null for a one-shot). With nothing empty beneath, ● on a
  committed clip — or a group whose committed direct clips exist — calls
  `newTake`; ● again cancels. The lane keeps its tiles, `silent`
  (dimmed) under the live bar, whose length runs from the slot top; the
  arm marker waits at the slot's next top. Published state cannot say
  "retake" (the slot keeps its duration), so app.js infers it: a
  committed clip that goes hot can only be retaking (`opts.retakes`).
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

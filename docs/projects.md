# Projects: Folders, Birth, the Mirror, and Templates

> Status: **spec** — owner-ratified 2026-07-19f (both forks ruled:
> birth at first committed take; continuous mirror). Implemented the
> same night: `src/project_manager.{h,cc}`, session_io SaveOptions,
> bridge + mock + UI. Pinned by `tests/project_manager_tests.cc`.

The design distills the owner's Ableton workflow (template → seed take →
build → save-as-date) into three rules.

## Rule 1 — A project is a folder; the folder name is its ID, not its name

```
~/Music/Celestrian/Projects/20260719-01/
    session.json      the graph (QTime, device-independent)
                      + "name" (display) + "created"
    audio/<uuid>.wav  one 32-bit float wav per committed take
```

- Auto-named `YYYYMMDD-NN`, first free serial that day, from `-01` —
  the owner's dating convention, codified. No dialogs.
- **Rename edits `name` inside session.json and never moves the
  folder.**
- **Loading never reads the folder name.** Everything a project needs
  is inside its folder; copy it anywhere (another machine, a renamed
  folder), point Celestrian at it, it loads. That is the portability
  contract.
- "Duplicate project" copies the folder to the next free serial and
  forks FORWARD (you keep working in the copy; the original stays as a
  checkpoint) — the `-02` habit, codified for versioning.

## Rule 2 — A template is a project with no performances

Same bundle format, stored in `~/Music/Celestrian/Templates/<name>/`.
"Save as template" keeps STRUCTURE — track names, order, groups, input
assignments, mute, fx settings — and strips every PERFORMANCE fact:
audio, durations, origins, windows, and (Q, epoch). Since Q is born
from the first take, **a template is pre-Q by construction** — loading
one drops you exactly at the top of the ritual: play the seed on
whichever instrument wants to start, Q is born, build.

## Rule 3 — Save is a mirror, not an event

- **Birth at the first committed take** (owner ruling): the dated
  folder is auto-created the moment a performance worth keeping
  exists. Junk sessions are a folder delete, not a lost save.
- **Continuous mirror** (owner ruling): after birth, the folder tracks
  the session. Takes are written **incrementally** — committed audio
  is immutable (no overdub), so a wav is written once and skipped
  thereafter; a Q13 lock-collapse changes the clip's duration, which
  is exactly the mismatch that triggers the one legitimate rewrite.
  session.json rewrites on each heartbeat tick (3 s, message thread),
  never while a take is in flight (transient state is not saved).
- **A crash loses at most the take in flight.**
- ⌘S remains as "checkpoint now" — and an explicit ⌘S before the
  first take is intent enough to birth the project early.

## The launch ritual (owner-refined 2026-07-19g)

> **SUPERSEDED 2026-08-13 by Q17 "Boot empty" (design_language.md):**
> the first bullet below — boot into the last/Default template, "never
> boots into an empty screen" — is retired along with
> `ensureLaunchSession`'s seeded "Track 1". The app boots EMPTY; `R`
> creates + arms the default track; every + is a template picker.
> Whole-session templates remain an explicit save-as / new-from choice
> in the Project menu. The remaining bullets (per-track record, tempo
> chip, post-hoc groups, selection) stand.

- ~~Boot = the last template used or saved. On the very first run, the
  app BUILDS the minimal **Default** template (one ready track,
  "Track 1"), saves it, and boots into it — the user edits their setup
  and saves over Default (the Ableton default-set ritual). **The app
  never boots into an empty screen, and recording is always one
  click.**~~
- **PER-TRACK RECORD, no global button** (owner ruling 2026-07-19h,
  supersedes the same-day staging model): the track's ● is THE record
  verb — the core journey is "song looping → ＋ Track → hit its ● →
  recording at the next boundary", and a global button optimized the
  first-run demo at that journey's expense. A group's ● records all
  its empty tracks (the drum-mic case); a recording track's ● stops
  it; full tracks disable it (no overdub).
- **The tempo track is explicit**: while Q is provisional, the
  definer's rail wears a red TEMPO chip; the badge retires when a
  second take locks the island (Q belongs to the island, not a track).
- **Creation lives in the canvas**: a persistent ＋ Track row under
  the lanes. **Groups are a post-hoc GESTURE, not an upfront
  decision** (owner ruling): drag one track's rail onto another's —
  clip target → the two combine into a new group (undoable Combine
  edit); group target → the dragged track moves inside; nesting falls
  out (drop onto a track inside a group combines in place). Groups
  keep their internal add-track rows. The transport carries no
  creation or record buttons — it is transport + project identity.
- **Selection + the grouping verbs' inverses** (2026-07-19j): click a
  rail to select (⌘-click adds, Escape/canvas-click clears); ≥2
  selected raises a floating "Group N tracks" bar (combine at the
  first-selected's slot); dragging a selected rail carries the whole
  selection. DRAG-OUT: while dragging, the ＋ Track row becomes the
  "move to top level" target — the same physical language, inverted.
  UNGROUP: a hover control on group rails moves the children up to the
  group's slot and removes the shell. Composed verbs step through ⌘Z
  one edit at a time (single-edit undo for composites is a recorded
  follow-up).
- No onboarding copy in the product. The empty state (only reachable
  by deleting every track) is one dry line.

## Surfaces

- Transport bar: the project name IS the menu button
  ("20260719-01 ▾"); rename is an inline row in the menu.
- Templates and recents live in the Project menu.
- Bridge: `getProjectInfo`, `renameProject`, `saveProjectNow`,
  `listTemplates`, `listRecentProjects`, `newProjectFromTemplate`,
  `openProjectPath`, `saveAsTemplate`, `duplicateProject` (3-place
  contract: protocol.js ↔ main_component.cc ↔ mock).

## Deferred (recorded, not designed away)

- Orphan wav pruning (undo can resurrect deletes; disk is cheap — a
  cleanup pass on close/save later).
- Device-name-aware input fallback on cross-machine load (today:
  channel indices load as-is).
- Cross-rate load (the QTime storage makes it possible without a
  re-cut; not yet implemented).
- **Export (WAV/MP3 mixdown)** — deferred until the sequencer / song
  structure module exists (owner ruling 2026-08-19): the session loops,
  so "how long is the piece" has no answer yet. When it lands, the
  cheap pre-sequencer form is a master-bus bounce of exactly N island
  cycles (the master cycle is well-defined today); full arrangements
  and MP3 wait for song structure.

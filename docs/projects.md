# Projects: Folders, Birth, the Mirror, and Templates

> Status: **canon** — owner-ratified 2026-07-19f (both forks ruled:
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

- Boot = the last template used or saved. On the very first run, the
  app BUILDS the minimal **Default** template (one ready track,
  "Track 1"), saves it, and boots into it — the user edits their setup
  and saves over Default (the Ableton default-set ritual). **The app
  never boots into an empty screen, and recording is always one
  click.**
- ONE record button. The transport's red circle is the only record
  verb on screen; per-track arm controls are small RINGS (state
  toggles — filled when armed) so "what will record" is glanceable
  without competing with the verb. (Field: three identical red dots
  read as three mystery record buttons.)
- **Arm = STAGING** (owner refinement, same day): the ring is pure
  view state — clicking it records nothing. The transport ● records
  the staged tracks; with none staged, every empty track (so boot →
  ● stays one click); on a recording track the ring stops that track.
  Staging is consumed by the take.
- **The tempo track is explicit**: while Q is provisional, the
  definer's rail wears a red TEMPO chip; the badge retires when a
  second take locks the island (Q belongs to the island, not a track).
- **Creation lives in the canvas**: a persistent ＋ Track / ＋ Group
  row under the lanes (groups keep their internal add-track rows for
  nesting). The transport carries no creation buttons.
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
- Default-template auto-open on launch (today: the empty state offers
  templates one click away).
- Cross-rate load (the QTime storage makes it possible without a
  re-cut; not yet implemented).

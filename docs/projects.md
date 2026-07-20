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

## Surfaces

- Transport bar: display name (click to rename inline; the ID lives in
  the tooltip). Hidden until birth.
- Empty state: **Start from template** (the boot ritual) + **Recent
  projects** (newest first, display names).
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

# The Sequencer: Constructing a Song from the Island

> Written 2026-08-19 from the owner's ask: *"record my set of loops and
> then easily construct a song — 4 bars of just bass, drop in the drums,
> add guitar & vocals, take away everything but guitar, bring back the
> bass/drums."* Three design options for review, with a recommendation.
> Companion docs: kernel.md (the clock and time-maps), design_language.md
> (invariants I1–I9, rulings Q1–Q17), time_maps.md (the map primitive).
>
> Status: **proposal — options for owner review, nothing ruled.**

---

## 1. The problem, stated in canon terms

Today the island is a *jam*: every committed loop sounds at once,
phase-locked on one grid, forever. The only macro-time verbs are the
performance verbs — mute and solo, applied live by hand. A *song* is the
thing the jam is missing: a plan over macro time saying **which tracks
sound, when, for how long** — so the island can play "4Q of bass alone,
then bass+drums, then everything, then just guitar" without the owner
riding the mute buttons.

Two observations shape every option below:

1. **The ask is about audibility, not time.** "Drop in the drums" does
   not move the drums — they keep looping in phase exactly as recorded
   (I1); a section merely *un-gates* them. This is mute automation on a
   schedule, not clip launching. Nothing in the ask requires remapping
   time, which is why the minimal design is dramatically smaller than a
   traditional DAW arrangement view.
2. **Phase-lock makes sections trivially musical.** Because every take
   is anchored to the island grid by origin, a track entering at *any*
   whole-Q boundary enters exactly where it would have been had it
   sounded all along. There is no launch-quantization problem to solve —
   the kernel already solved it. Entrances are free.

Vocabulary proposal (design_language.md §1 says an island IS one song,
so "song" would collide): the new object is the **Arrangement** — an
ordered list of **Sections**. Each section names a length and a set of
audible tracks.

---

## 2. Option A — The Section Rail (arrangement as gate schedule)

The minimal object that answers the ask completely.

### Data model

One object stored at the island root (beside `Q` and `epoch` — the same
home P0-3 found for island facts):

```
arrangement = {
    state: none | active | bypassed,        // the map vocabulary, reused
    sections: [ { name, lenQ, gates: { nodeId → on } }, ... ]
}
```

- `lenQ` — whole Qs ("4 bars of just bass" → `lenQ: 4`). Whole-Q only,
  by the same reasoning as the seam theorem: Q-multiple boundaries keep
  the groove transparent. The UI can offer cycle-multiples as the
  snap default.
- `gates` — which nodes sound during the section. Keyed by node id;
  **fractal (I5)**: a gate on a group gates its subtree, exactly like
  mute. Absent id = inherit (on), so adding a track later doesn't
  silently vanish from old sections.
- `state` — deliberately the time-map vocabulary: `bypassed` returns
  the island to today's everything-sounds jam. The jam is not a second
  mode; it is the arrangement bypassed.

### Playback semantics

No second clock (I8). The arrangement position is a pure derivation:

```
songLen  = Σ lenQ · Q_samples
songPos  = (t − epoch) mod songLen          // loops as a whole
section  = prefix-sum lookup of songPos
audible(node) = section.gates[node] ?? true
```

The audio thread resolves the active section per callback from the
snapshot + clock — the exact shape of the Q16 solo scan (`snapAnySolo`):
no republish, no cached pointer, RT-safe by construction. A gated-off
node renders silence through the same path mute uses today.

**Gates compose with the performance verbs**: manual mute still mutes a
gated-on track (both must pass); solo behaves per the Q16 canon over
the *gated* population. The performance verbs stay live during song
playback — you can still ride a mute over the arrangement, which is
what makes it a looper's sequencer rather than a tape.

**The content phase sails on underneath.** A drum loop gated off for
sections 1–2 and on at section 3 enters at the phase it would have had
— the mute model, not the launch model. This is the I1-consistent
choice and the one that keeps every entrance in sync for free. (One-
shots are the interesting case: a one-shot's period is the context
cycle, so it fires once per cycle *while gated on* — a "fill" is a
one-shot gated on only in the section that wants it. This falls out;
nothing extra to build.)

### State table (the ask, verbatim)

Q = 1 bar. Tracks: bass, drums, guitar, vocals.

| section | lenQ | bass | drums | guitar | vocals |
|---|---|---|---|---|---|
| intro | 4 | ● | | | |
| groove | 4 | ● | ● | | |
| full | 8 | ● | ● | ● | ● |
| breakdown | 4 | | | ● | |
| out | 8 | ● | ● | | |

```
lane view (arrangement active — frame = the whole song, 28Q):

        intro    groove   full············ breakdn  out·········
bass    ████████ ████████ ████████████████ ▒▒▒▒▒▒▒▒ ████████████
drums   ▒▒▒▒▒▒▒▒ ████████ ████████████████ ▒▒▒▒▒▒▒▒ ████████████
guitar  ▒▒▒▒▒▒▒▒ ▒▒▒▒▒▒▒▒ ████████████████ ████████ ▒▒▒▒▒▒▒▒▒▒▒▒
vocals  ▒▒▒▒▒▒▒▒ ▒▒▒▒▒▒▒▒ ████████████████ ▒▒▒▒▒▒▒▒ ▒▒▒▒▒▒▒▒▒▒▒▒
        ↑ gated-off cells render the lane's tiles dimmed (▒), lit when on
```

### UI

A **section strip** above the lanes: one block per section, width ∝
`lenQ`, carrying name + length chip ("4Q"), with bracket-style handles
to resize (whole-Q snap — the trim-grip vocabulary), drag to reorder,
double-click to split/merge, a + at the end to append. When the
arrangement is active the display frame becomes the song: lanes tile
their existing cycle rendering across the full width (pure projection —
the reps machinery already tiles), and each lane×section cell is a
click-toggleable gate (the cut-band cell gesture, lifted from time to
tracks). The playhead sweeps the song; section boundaries get ruler
ticks. Bypass chip on the strip mirrors the map chip.

One deliberate symmetry, worth naming in the design language: **cut
bands select which TIME of one track sounds; the arrangement selects
which TRACKS sound over macro time.** Same gesture (cells + brackets +
chips), same reversibility story (gates are data; nothing is baked;
bypass restores the jam — I9's shape).

### What it touches

Engine: arrangement storage + per-callback section resolve + gate test
in the render path (mute-sized); `Edit::Arrangement` (undoable, raw-
state inverse like `Edit::Segments`). Bridge (3 places):
`setArrangement` / `toggleArrangement`. Mock twin. VM: `songLenQ`,
`sections[]`, per-lane per-section gate + the frame switch. UI: the
strip + cell toggles. Tests: C++ gate-resolution + I1-entrance-phase
golden; mock twin; e2e strip interactions. Save format: additive
(`arrangement` block, QTime lengths).

Also unblocked: **export** (projects.md defers WAV mixdown "until the
sequencer") gets its natural definition — render the section list once
through, `songLen` samples, done.

### Limits (honest)

On/off is the only per-section fact. No per-section alternate takes, no
per-section windows, no tempo/key changes, no transitions/fills beyond
what one-shots give. The format is additive, so all of these can ride
later — but v1 sections are gates, nothing more.

---

## 3. Option B — Sections as Scenes (the serial-box road)

The full vision from design.md §Roadmap (mode 2: boxes, connections,
transitions), entered through the sequencer door.

Each section becomes a **Scene node**: a first-class child of a serial
group whose time-map concatenates children (the Q6 provisional ruling —
serial composition = concatenation of periods; in kernel terms a
time-map routing each child a sub-range of the cycle). A scene
*references* the island's tracks and carries per-scene overrides:
audibility (Option A's gates) at minimum, later per-scene loop windows
("the drums play cells {1,3} in the breakdown"), per-scene takes (the
Q7 takes companion: same origin/period, alternate buffer), per-scene
fx/gain.

### Why it's attractive

- It is where the roadmap already points: branch-with-chance,
  transitions, the infinite radio are all edges on scenes. Building
  scenes now means the sequencer *is* the first box graph.
- Per-section variation is real, not deferred: verse-drums vs
  chorus-drums as scene-local windows/takes on one shared track.
- The serial time-map is the same primitive as everything else — the
  algebra composes (a scene of scenes is a bridge/medley for free, I5).

### Why it's expensive

- **Reference semantics is a new kind of edge.** Today the graph is a
  tree; a track appearing in five scenes is either five copies (memory,
  and edit-once-update-everywhere dies) or a shared reference (aliasing:
  who owns it, what does delete mean, how does undo capture it, how
  does the snapshot publish it RT-safely). This is THE design decision
  of Option B and it deserves its own ruling round before code.
- **Serial time-maps are unimplemented** (Tier 5, Segment 9). Q6 is
  provisional; recording-inside-a-scene, epoch-per-traversal, and the
  UI for stepping into a scene are all unruled.
- The ask is answered by gates alone; everything beyond gates is
  speculative until field use demands it (the Q13 lesson: build the
  affordance the field asked for, let the next field session name the
  next one).

### The bridge between A and B

Option A's section `{name, lenQ, gates}` is exactly a **degenerate
scene** (references + audibility overrides, no time-map of its own).
If A stores gates keyed by node id and keeps the arrangement's format
additive, migrating A's data into B's scenes later is mechanical. A
does not foreclose B; it front-runs it.

---

## 4. Option C — Perform the Arrangement (capture the gesture)

The looper-native front end: you already *perform* arrangements every
time you jam — riding mutes is how the owner describes songs today. So
record it. Arm a **song take**: playback runs, the owner rides
mute/solo live, and every gesture is captured **quantized to the next
whole Q** (the Q11 shape: any click before a boundary means that
boundary) into gate changes. Stop, and the captured timeline
materializes as Option A's section list — boundaries wherever the gate
set changed, editable on the strip afterward.

- Capture is UI/message-thread only (gestures → timestamps → fold to
  Q); the audio thread learns nothing new.
- The performance IS the edit surface for the first pass; the strip is
  the refinement surface. This matches how loop artists actually build
  arrangements (nobody types section lengths first).
- It is strictly additive over A — same data, one more way to write it.
  Standalone it is not viable (a capture with no editor is a tape you
  can't splice), so C is a phase-2 verb, not a competing design.

---

## 5. Comparison

| | A — Section Rail | B — Scenes | C — Capture |
|---|---|---|---|
| Answers the ask | completely | completely + more | completely (via A) |
| New engine concepts | gate schedule (mute-sized) | references/aliasing + serial maps | none beyond A |
| I1/I8 risk | none (audibility only, derived position) | real (epoch-per-traversal, recording-in-scene) | none beyond A |
| Per-section variation | no (format additive) | yes | no (inherits A) |
| Feeds export | yes | yes | yes |
| Feeds boxes/radio vision | via migration | IS it | via A |
| Size | small | large (own ruling round first) | small, after A |

## 6. Recommendation

**A, shaped for B, with C as the follow-up verb.** Concretely:

1. Build the Section Rail: arrangement at the island root, gates
   fractal and mute-shaped, whole-Q lengths, active/bypassed state,
   one undoable edit, strip + cell UI, export unlocked.
2. Two format commitments to keep B cheap later: sections are
   node-id-keyed override maps (a degenerate scene), and the
   arrangement block is additive/versioned.
3. Add C (song-take capture) once the strip exists — it writes A's
   data through the gesture the owner already performs.
4. B waits for its own ruling round (reference semantics first), and
   arrives as a migration, not a rewrite.

## 7. Questions for ruling (S-series)

- **S1 — Gate shape.** Ratify mute-shaped entrances (content phase
  sails on underneath; every entrance in phase by construction) over
  launch-shaped (track restarts at section top, breaking I1's spirit)?
  Recommendation: mute-shaped; a restart-from-top is a per-scene
  time-map, i.e. Option B territory.
- **S2 — Length unit.** Whole Qs with cycle-multiple snapping as the
  UI default? A 4Q section over a 3Q loop means the loop enters
  mid-phase at the next section — honest per I1, but worth a ruling
  that this is intended (it is what a hardware looper does).
- **S3 — End behavior.** Does the arrangement loop as a whole
  (recommended default — consistent with everything-loops) with
  play-once as an export/radio mode later?
- **S4 — Verb composition.** Manual mute ∧ gate (both must pass) and
  solo-over-gated-population per Q16 — confirm?
- **S5 — Recording while the arrangement is active.** Refuse the arm
  (v1, mirrors the nested-map refusal) or auto-bypass? Recording INTO
  a section (the section as context loop) is a real future feature —
  defer it explicitly?
- **S6 — Vocabulary.** "Arrangement/Section" (avoids the island=song
  collision)? Strip placement above the ruler vs below the lanes?
- **S7 — Tails.** A gated-off track with echo/reverb: ring out or cut?
  (Same open question as effect-tails-on-mute, tasks.md — inherit
  whatever that ruling becomes.)

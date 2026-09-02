# Celestrian Glossary

The canonical vocabulary is **docs/design_language.md §1** — edit there,
not here. This is a compact copy of the most-used terms (trued
2026-09-01). Units: samples (engine), Q (musical), pixels (UI) — always
name yours.

| Term | Definition |
|---|---|
| **Quantum (Q)** | The atomic musical duration of an island, in samples. Established by the first committed take; the grid everything snaps to. "One bar." |
| **Island** | The scope within which Q is shared. One island = one song = one time grid. |
| **Origin** | The master-cycle moment a clip's content belongs to: the performance-time at which `content[0]` occurred. The ONE stored timing fact per clip (kernel.md). |
| **Performance time** | The frame the musician lives in: what they *heard*. Input arriving at master time `t` was performed at `t − C` (C = calibrated round trip). All musical positions are performance-time. |
| **Context loop** | The loop the performer was listening to when they hit record: the longest committed sibling (min Q). Determines how their intent wraps. |
| **Cycle (LCM)** | The period after which every member of a scope returns to phase 0 simultaneously: LCM of member (effective) periods. A derived legibility device, not a modeling principle (Q2). |
| **Launch point** | Derived, never stored: the playback offset that makes a clip honor its origin. `launch = (−origin) mod period`. |
| **Ghost / Echo** | The visual unrolling of a loop across the cycle: its AUDIBLE repetitions, drawn in the cool echo tone. For a windowed clip, echoes show the window segment (what sounds), never raw take material. Whole cycle-counts fold away; the performed phase is kept (Q14). |
| **One-shot** | A clip whose period is the context cycle rather than its own length: it sounds once per cycle at its origin, then rests. A period-source KNOB (`periodSource`, the ↺/1× rail chip), not a duration rule (Q5). |
| **Composite** | A stack seen from outside: a virtual clip whose content is the sum of its children and whose period is their LCM (effective period: window ▸ active sequence ▸ children's effective LCM — sequencer.md §2). |
| **Loop window** | A `[start, end)` restriction on a node's cycle — a one-segment time-map. Active iff valid and not bypassed; independent of view state (time_maps.md). |
| **Time-map** | THE mechanism that transforms time: an ordered segment list phased off the cycle epoch, `m(t) = epoch + walk_segments((t − epoch) mod period)`. Loop windows, non-contiguous selections, and (future) warp / serial connections are all instances. |
| **Hysteresis snap** | ARM: the target is always the next Q boundary in the heard frame (Q11). STOP: always forward — a stop records on to the NEXT boundary (2026-07-10). Every map/window period is a whole multiple or exact divisor of Q (engine_lcm_guard.md). |
| **Fractality** | The law that any subtree, collapsed, obeys exactly the laws of a clip. If a rule doesn't hold recursively, it isn't a rule yet. |

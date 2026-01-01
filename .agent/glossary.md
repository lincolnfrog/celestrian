# Celestrian Glossary

## Recording & Playback

**Quantum (Q)**: The fundamental time unit. First clip's duration defines Q. All subsequent clips are measured relative to Q.

**Launch Point**: Where playback starts within a clip to maintain Audio Memory alignment. Formula: `(duration - anchor) % duration`. The orange arrow shows this position.

**Context Loop**: The longest existing clip's duration when a new recording starts. Used to calculate loop-relative positions.

**Effective Position**: Loop-relative position where user pressed record. Not global time - represents the playhead position within the context loop.

## Visual Elements

**Ghost Clip**: Faded repetition showing where a looping clip will play. Only looping clips (duration >= Q) get ghosts.

**One-Shot**: Clip with `duration < Q`. Plays once per cycle, shown with dashed border.

**Quantum Marks**: Faint vertical lines at Q boundaries shown during recording and loop editing.

## Audio Alignment

**Audio Memory Principle**: Recorded audio must play back aligned with what the performer heard during recording. The launch_point calculation ensures this.

**Auto-Quantize**: Recording always starts and stops at the next clean quantum boundary. This keeps loops synchronized with the rhythmic grid.

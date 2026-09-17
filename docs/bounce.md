# Bounce / export

> Status: **spec**. The ruling is design_language.md Q19; the tracker
> item is tasks.md B2. Code: `src/engine/bounce.cc`,
> `AudioEngine::bounce`, the `bounce` / `bounceWithDialog` bridge verbs.

## The ruling (Q19)

A bounce renders the island ROOT for one EFFECTIVE cycle — the whole
song when a sequence is active — through the real render path at the
device rate, letting effect tails ring past the end. Any node can be
bounced the same way. No N-cycles dialog, no selection-dependent scope.

## The span

- **The top — one law for every node (audit D15-1, 2026-09-10):** the
  node's frame top, `origin + a0` (a0 = the active map's first segment
  start; an unanchored stack's frame is the island frame, so its top is
  the epoch — the root's too, unless a song anchors it at the zero the
  song was authored on (frame.md §4); so a root bounce starts at its
  frame top `+ a0`: the moment its song or window starts, not the
  moment the island cycle wraps).
- **The span — root:** one effective cycle
  (`calculateEffectiveCycleLength`; Q19 — the cycle the transport wraps
  on, so a root window shorter than Q repeats within it).
- **The span — any other node:** its own period by THE PERIOD LAW
  (`period_law::ownPeriodOf`: map ▸ sequence ▸ content). A one-shot
  bounces its shot.

The render clock starts at the frame top and advances in 512-sample
blocks; the monotonic transport is untouched, so musical time never
moves for the UI. Blocks are built by `engine_internal::renderContext`,
the SAME builder the device callback uses — the bounce adds nothing to
it, which is what makes the bounce the live render, offline.

## The tail

Past the span every block carries `ProcessContext::content_silent`:
leaves render silence into their racks (a closed gate with no ramp;
MIDI clips release held notes) while gates, chains and output stages
keep running. Rendering continues until the block peak has stayed
under −90 dBFS for 0.5 s, capped at 10 s; the file keeps the tail
through its FIRST block under the floor. A node with nothing ringing
ends exactly at its span.

## The format

Stereo 32-bit float WAV at the device sample rate. Parent directories
are created; an existing file is replaced.

## Refusals

`false`, no file: a take armed or recording anywhere (the render would
advance every leaf's control phase on its own clock); a target with no
committed content; an unknown node; a file that cannot be written.

## Caveats

- The device callback is removed for the render and re-added after:
  the speakers fall silent for the duration, and live effect tails
  (echo lines, plugin state) are perturbed by the render — the graph's
  DSP scratch is advanced by exactly one renderer at a time.
- Q20 software monitoring is not rendered — the bounce context carries
  no pre-record ring, so input never reaches a bounce (tests/monitor_tests.cc).

## The golden

`tests/bounce_tests.cc` pins **bounce == live render**: a ramp-input
take is bounced, then the live callback is driven from the same frame
top over the same cycle, and the WAV equals the output sample for
sample on both channels. Alongside: a windowed group spans exactly its
effective period, a live take refuses, an echo tail rings past the
span and ends under the floor. UI: `ui/js/mock/bounce.js` is the mock
twin; `ui/e2e/bounce.spec.js` drives the project menu.

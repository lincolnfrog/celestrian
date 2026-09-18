# Audio file import (B6)

A WAV/AIFF/FLAC becomes a **committed take** — nothing else is new. The
file decodes on the message thread (`src/engine/import.cc`) to an exact-
size buffer at the device rate and commits through the take path, so
every take fact (docs/takes.md) holds for imported material.

## The verbs

| Verb | Does |
|---|---|
| `importAudio(uuid, path, originSamples)` | the direct form: the origin in absolute samples, which the view computes from the frame zero it seated (frame.md); the engine snaps it to the Q grid |
| `importAudioWithDialog(uuid, originSamples)` | picks the file natively, then the same; `false` when cancelled |

Refused (`false`) while any take is live or armed, on a MIDI track, on a
full take list, or for an unreadable file.

## Placement and length

- **Nearest Q boundary.** The view names the origin in absolute
  samples — the frame zero it seated plus whole Qs (frame.md; a drop's
  Q is the pointer's fraction of the lane body over the lane's frame
  cycle, `import_drop.dropFrameQ`; the menus import at the zero) — and
  the engine snaps it to the nearest boundary of the island's Q grid,
  whose phase is the island zero (Q11).
- **The hysteresis length law** (`timing::snapCommittedDuration`): the
  file's length snaps to the nearest of {the floor multiple of Q, the
  next multiple, Q/2, Q/4, Q/8} when that candidate is within 15 % of Q;
  otherwise the take keeps its free length with its loop end at the
  floor multiple. The record path's law, unchanged.
- **Pre-Q import defines Q.** On an island with no quantum the file's
  length *is* Q and the clock is the origin — the first-take rule.
- **A stack target** gains a fresh clip child named after the file.
- **A committed slot** takes a **new take** cut or zero-padded to the
  slot's period, active on arrival — the slot's origin and period stand.
- **Resampling.** A mismatched file rate resamples every channel
  (Lagrange); channels beyond two fold onto the stereo pair.
- **Undo.** Each import rides the take entry (Take/Untake): ⌘Z removes
  the take, or the whole clip when the import created it.

## The UI half (`ui/js/app.js`, `import_drop.js`, `lane_build.js`)

- **Drop onto a lane body**: the first file, at the pointer's Q.
- **"Import audio…"** in every + menu (into that group) and in the
  project menu (a new track at the frame top).
- The status line carries the verdict: imported (⌘Z), refused under a
  live take, or cancelled.

### The WebView path limit

A `File` dropped into the app's WKWebView / WebView2 page carries its
**name only** — a sandboxed page is never handed a filesystem path.
`import_drop.filePathOf` reads a non-standard `path` when a host exposes
one and imports directly; otherwise the drop falls back to the native
chooser **placed at the drop's Q**, so the gesture still fixes *where*
even when it cannot fix *what*.

Tests: `tests/import_tests.cc`, `ui/js/tests/import_mock.test.mjs`,
`ui/e2e/import.spec.js`.

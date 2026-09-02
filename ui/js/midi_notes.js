/**
 * MIDI notes for the lane (docs/vst3.md §11): the pure functions
 * between the bridge's `getMidiNotes` rows and the piano-roll tile —
 * event pairing (the mock's twin of AudioEngine::getMidiNotes), the
 * bridge-row decode, the compact pitch-range fit, and the slice of a
 * take's notes into ONE rep tile (the same `srcSegs` / rotation rules
 * the audio tile applies to its peaks). No DOM, no canvas.
 */

/** The smallest pitch span a tile fits (semitones): one note still
 * reads as a bar, not a line. */
export const MIN_PITCH_SPAN = 12;

/**
 * Pair raw content events into notes. `events` are [pos, status, data1,
 * data2] with `pos` in samples of the content frame; a note-on with
 * velocity 0 is a note-off; note-offs match the most recent open note
 * of the same channel and pitch; an unpaired note-on runs to
 * `durationSamples`. Events outside [0, duration) are ignored. Returns
 * [{pos, len, note, vel}] sorted by position.
 */
export function pairMidiEvents(events, durationSamples) {
    const open = new Map();  // channel*128 + note → [{pos, vel}]
    const notes = [];
    for (const ev of events || []) {
        const [pos, status, note, vel] = ev;
        if (!(pos >= 0) || pos >= durationSamples) continue;
        const kind = status & 0xF0;
        const key = (status & 0x0F) * 128 + note;
        const isOn = kind === 0x90 && vel > 0;
        const isOff = kind === 0x80 || (kind === 0x90 && vel === 0);
        if (isOn) {
            if (!open.has(key)) open.set(key, []);
            open.get(key).push({ pos, vel });
        } else if (isOff) {
            const stack = open.get(key);
            if (!stack || !stack.length) continue;
            const on = stack.pop();
            notes.push({ pos: on.pos, len: pos - on.pos, note, vel: on.vel });
        }
    }
    for (const [key, stack] of open) {
        for (const on of stack) {
            notes.push({ pos: on.pos, len: durationSamples - on.pos,
                         note: key % 128, vel: on.vel });
        }
    }
    return notes.sort((a, b) => a.pos - b.pos);
}

/** Bridge rows [[posNum, posDen, note, vel, lenNum, lenDen], …] →
 * [{posQ, lenQ, note, vel}] (Q units). */
export function notesFromRows(rows) {
    return (rows || []).map(r => ({
        posQ: Number(r[0]) / (Number(r[1]) || 1),
        note: Number(r[2]),
        vel: Number(r[3]),
        lenQ: Number(r[4]) / (Number(r[5]) || 1),
    }));
}

/**
 * The COMPACT pitch range a tile draws: the notes' [lowest, highest]
 * widened to at least MIN_PITCH_SPAN semitones (centered) and padded
 * by one semitone each side, clamped to MIDI pitch. An empty list
 * fits the middle octave. Returns {lo, hi} (inclusive).
 */
export function fitPitchRange(notes) {
    if (!notes || !notes.length) return { lo: 54, hi: 66 };
    let lo = Infinity, hi = -Infinity;
    for (const n of notes) {
        if (n.note < lo) lo = n.note;
        if (n.note > hi) hi = n.note;
    }
    lo -= 1;
    hi += 1;
    const span = hi - lo;
    if (span < MIN_PITCH_SPAN) {
        const grow = MIN_PITCH_SPAN - span;
        lo -= Math.floor(grow / 2);
        hi += Math.ceil(grow / 2);
    }
    if (lo < 0) { hi -= lo; lo = 0; }
    if (hi > 127) { lo -= hi - 127; hi = 127; }
    return { lo: Math.max(0, lo), hi: Math.min(127, hi) };
}

/**
 * Slice a take's notes into ONE rep tile, in tile fractions [0, 1):
 * the audio tile's rules exactly — `src` is the list of [f0, f1]
 * content ranges (fractions of `intrinsicQ`) the tile concatenates
 * (null = the whole take), `rotFrac` rotates the loop's heard top to
 * that fraction of the tile. A note is clipped to the ranges it
 * overlaps (a note crossing a cut is cut). Returns [{f0, f1, note,
 * vel}] with f1 > f0.
 */
export function sliceNotesToTile(notes, intrinsicQ, src, rotFrac = 0) {
    if (!(intrinsicQ > 0) || !notes || !notes.length) return [];
    const ranges = src && src.length ? src : [[0, 1]];
    const total = ranges.reduce((n, [a, b]) => n + (b - a), 0);
    if (!(total > 0)) return [];
    const out = [];
    let acc = 0;
    for (const [a, b] of ranges) {
        const w = b - a;
        for (const n of notes) {
            const n0 = n.posQ / intrinsicQ;
            const n1 = (n.posQ + n.lenQ) / intrinsicQ;
            const c0 = Math.max(n0, a);
            const c1 = Math.min(n1, b);
            if (c1 <= c0) continue;
            let f0 = (acc + (c0 - a)) / total;
            let f1 = (acc + (c1 - a)) / total;
            const rot = ((rotFrac || 0) % 1 + 1) % 1;
            if (rot > 0) {
                // Rotation: the tile shows the content from its heard
                // top; a bar straddling the seam splits in two.
                f0 = (f0 + rot);
                f1 = (f1 + rot);
                if (f0 >= 1) { f0 -= 1; f1 -= 1; }
                if (f1 > 1) {
                    out.push({ f0, f1: 1, note: n.note, vel: n.vel });
                    out.push({ f0: 0, f1: f1 - 1, note: n.note, vel: n.vel });
                    continue;
                }
            }
            out.push({ f0, f1, note: n.note, vel: n.vel });
        }
        acc += w;
    }
    return out;
}

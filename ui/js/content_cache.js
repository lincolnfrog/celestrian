/**
 * The content the lanes draw, read from the backend on demand and kept
 * per clip: waveform peaks (live while a take captures), per-take peaks
 * (take_peaks.js), the retake inference and MIDI notes. The poll feeds
 * it the graph; the patch layer reads it through `patchInputs`.
 */

import { appendLivePeak } from './live_peaks.js';
import { peakCountFor } from './peak_density.js';
import { createTakePeakCache } from './take_peaks.js';
import { notesFromRows, fitPitchRange, rescaleNotes } from './midi_notes.js';
import { lastNodesById, isHotClip } from './session_facts.js';
import { FALLBACK_SAMPLE_RATE } from './sample_rate.js';

/** peakKeys marker: the array holds a take still being captured. */
const LIVE = 'live';

/** The identity of a clip's ACTIVE content. getWaveform answers for the
 * active take, so a selection or a renumbering delete must refetch even
 * though the duration stands (docs/takes.md §3). */
export const peakKey = n =>
    (n.duration || 0) + ':' + (n.activeTake || 0) + ':' + (n.takes || 0);

/** The identity of a MIDI clip's notes: the event count, the take, and
 * Q — the rows are Q units, and trimming the tempo-setting take moves Q
 * under them (docs/vst3.md §8.5). */
export const midiKey = (n, quantum) =>
    (n.midiEvents || 0) + ':' + (n.activeTake || 0) + ':' + (n.takes || 0) +
    ':' + quantum;

/** How much of a recording clip's take is captured, in samples. A first
 * take's `duration` is its captured length; a NEW TAKE's is read off
 * the playhead (lane.recordingLengthQ: how far past the slot's top),
 * and is 0 until the slot's top comes round. */
export function capturedSamples(node, lane, quantum) {
    if (!lane || !lane.retake) return node.duration;
    return lane.pendingStart ? 0 : lane.recordingLengthQ * quantum;
}

/**
 * @param {object} deps
 * @param {(name: string, ...args) => Promise<*>} deps.callNative
 * @param {(msg: string) => void} [deps.debugLog]
 */
export function createContentCache({ callNative, debugLog = () => {} }) {
    const livePeaks = new Map();    // clip id → peak array
    const peakKeys = new Map();     // clip id → peakKey it was read at, or LIVE
    const peakReads = new Map();    // clip id → read in flight
    const midiNotes = new Map();    // clip id → {notes (Q units), range, quantum}
    const midiKeys = new Map();     // clip id → midiKey they were read at
    const midiReads = new Map();    // clip id → read in flight
    /** Clips whose live take trackRetakes saw begin as a NEW TAKE of a
     * committed slot — the takes it seeded. The view and the verbs read
     * the published fact instead: while a new take is armed or captures,
     * the slot's own period rides `periodQ` and `duration` is the take's
     * live length. */
    const retakes = new Set();
    let sampleRate = FALLBACK_SAMPLE_RATE;

    /** Peaks to ask for clip `id`, by its take's length
     * (peak_density.js). Every take of a slot shares the slot's
     * duration, so one count serves getWaveform and getTakeWaveform. */
    function peakCountOf(id) {
        const n = lastNodesById.get(id);
        return peakCountFor(n ? n.duration : 0, sampleRate);
    }

    /** One read per clip at a time; the poll asks again if the key
     * moved meanwhile. An empty answer is not kept. */
    function readWaveform(id, key) {
        if (peakReads.has(id)) return;
        peakReads.set(id, (async () => {
            try {
                const peaks = await callNative('getWaveform', id, peakCountOf(id));
                if (peaks && peaks.length > 0) {
                    livePeaks.set(id, peaks);
                    peakKeys.set(id, key);
                    debugLog(`Fetched ${peaks.length} peaks for ${id}`);
                }
            } catch (err) {
                console.error('Waveform fetch failed:', err);
            } finally {
                peakReads.delete(id);
            }
        })());
    }

    /**
     * Read the peaks of every committed clip whose content is not in
     * hand; for a RECORDING clip, append the engine's `currentPeak` at
     * the index its captured length names (live_peaks.js), so the drawn
     * waveform is anchored to time whatever the poll cadence.
     */
    function refreshPeaks(nodes, rate, vm) {
        for (const n of nodes || []) {
            if (n.type === 'stack') { refreshPeaks(n.nodes, rate, vm); continue; }
            if (n.type !== 'clip') continue;
            if (n.isRecording) {
                let arr = livePeaks.get(n.id);
                if (!arr || peakKeys.get(n.id) !== LIVE) {
                    arr = [];  // a fresh take drops the committed peaks
                    livePeaks.set(n.id, arr);
                    peakKeys.set(n.id, LIVE);
                }
                const captured = capturedSamples(
                    n, vm.lanes.find(l => l.id === n.id), vm.quantum);
                if (captured > 0) {
                    appendLivePeak(arr, captured, rate, n.currentPeak || 0);
                }
                continue;
            }
            if (!(n.duration > 0)) continue;
            // Also what replaces a live array once its take commits.
            if (peakKeys.get(n.id) !== peakKey(n)) readWaveform(n.id, peakKey(n));
        }
    }

    const takePeaks = createTakePeakCache({
        fetchPeaks: (id, k) => callNative('getTakeWaveform', id, k, peakCountOf(id)),
        isHot: id => {
            const n = lastNodesById.get(id);
            return !!n && isHotClip(n);
        },
    });

    /**
     * THE RETAKE INFERENCE: a clip that was committed and idle on the
     * previous poll and is hot now can only be taking a NEW TAKE — the
     * engine refuses a plain arm on content. A clip that is no longer
     * hot, or left the graph, leaves the set. The slot's silent tiles
     * go on drawing the take that was sounding, so its committed peaks
     * — in hand, and unreadable from the backend while the clip is hot
     * — seed the take cache here.
     */
    function trackRetakes(prev, next) {
        for (const id of retakes) {
            if (!next.has(id)) retakes.delete(id);
        }
        for (const n of next.values()) {
            if (n.type !== 'clip') continue;
            if (!isHotClip(n)) { retakes.delete(n.id); continue; }
            const was = prev.get(n.id);
            if (!was || isHotClip(was) || !((was.duration || 0) > 0)) continue;
            retakes.add(n.id);
            if (peakKeys.get(n.id) === peakKey(was)) {
                takePeaks.seed(n.id, was.activeTake || 0, livePeaks.get(n.id));
            }
        }
    }

    function readMidiNotes(id, key, quantum) {
        if (midiReads.has(id)) return;
        midiReads.set(id, (async () => {
            try {
                const notes = notesFromRows(await callNative('getMidiNotes', id));
                midiNotes.set(id, { notes, range: fitPitchRange(notes), quantum });
                midiKeys.set(id, key);
                debugLog(`Fetched ${notes.length} MIDI notes for ${id}`);
            } catch (err) {
                console.error('MIDI note fetch failed:', err);
            } finally {
                midiReads.delete(id);
            }
        })());
    }

    /** Read the notes of every committed, idle MIDI clip whose key
     * moved; a hot clip keeps its notes until its take commits. Notes
     * read at another Q are rescaled at once, so a live trim of the
     * tempo-setting take never draws them at the stale scale while the
     * read is out. */
    function refreshMidiNotes(nodesById, quantum) {
        for (const [id, m] of midiNotes) {
            if (m.quantum !== quantum) {
                midiNotes.set(id, { notes: rescaleNotes(m.notes, m.quantum, quantum),
                                    range: m.range, quantum });
            }
        }
        for (const n of nodesById.values()) {
            if (n.type !== 'clip' || n.contentKind !== 'midi') continue;
            if (isHotClip(n) || !(n.duration > 0)) continue;
            const key = midiKey(n, quantum);
            if (midiKeys.get(n.id) !== key) readMidiNotes(n.id, key, quantum);
        }
    }

    /** Poll hook, before the graph is adopted: drop the content of
     * nodes that left it (a node an undo brings back is read again by
     * key) and track the retakes across `prev` → `next`. */
    function noteGraph(prev, next) {
        for (const cache of [livePeaks, peakKeys, midiNotes, midiKeys]) {
            for (const id of cache.keys()) {
                if (!next.has(id)) cache.delete(id);
            }
        }
        takePeaks.noteNodes(next);
        trackRetakes(prev, next);
    }

    /** Poll hook, after the derive: bring notes and peaks up to
     * `state`. `vm` supplies Q and the lanes' take progress. */
    function refresh(state, vm) {
        const rate = (state.perf && state.perf.sampleRate) || FALLBACK_SAMPLE_RATE;
        sampleRate = rate;
        refreshMidiNotes(lastNodesById, vm.quantum);
        refreshPeaks(state.nodes, rate, vm);
    }

    /** What the patch layer draws from. `pendingFetch` holds the
     * committed clips whose real waveform has not landed: a composite
     * must not blend their live meter peaks (composite_waveform.js). */
    function patchInputs(nodesById) {
        const pendingFetch = new Set();
        for (const n of nodesById.values()) {
            if (n.type === 'clip' && !n.isRecording && n.duration > 0 &&
                peakKeys.get(n.id) !== peakKey(n)) {
                pendingFetch.add(n.id);
            }
        }
        return { livePeaks, pendingFetch, takePeaks: takePeaks.now, midiNotes };
    }

    /** Resolves once no read is out (tests). */
    const idle = () => Promise.all([...peakReads.values(), ...midiReads.values()]);

    return { retakes, takePeaks, noteGraph, refresh, patchInputs, idle };
}

/**
 * content_cache.js — what the lanes draw, driven poll by poll over a
 * fake backend: the content keys, one waveform read per content, live
 * peaks while a take captures, the retake inference and its seeded take
 * peaks, MIDI notes across a Q change, and what leaves with a node.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createContentCache, peakKey, midiKey, capturedSamples }
    from '../content_cache.js';
import { FALLBACK_SAMPLE_RATE } from '../sample_rate.js';
import { MIN_PEAKS, peakCountFor } from '../peak_density.js';
import { PEAKS_PER_SECOND } from '../live_peaks.js';
import * as facts from '../session_facts.js';
import { notePoll, indexNodes } from '../session_facts.js';

const RATE = 48000;
const Q = RATE;  // one second per Q

const clip = (id, extra = {}) => ({
    id, type: 'clip', duration: 0, activeTake: 0, takes: 0, ...extra });
const committed = (id, extra = {}) =>
    clip(id, { duration: 2 * Q, takes: 1, ...extra });

/**
 * A cache over a fake backend. `waveforms` / `notes` map a clip id to
 * what the backend answers (anything else answers []); `poll(nodes,
 * vm)` runs the cache's two poll hooks around the facts' hand-over, as
 * app.js does.
 */
function harness() {
    const backend = { waveforms: {}, notes: {}, asked: [] };
    const cache = createContentCache({
        callNative: async (name, id, ...rest) => {
            backend.asked.push([name, id, ...rest]);
            if (name === 'getWaveform') return backend.waveforms[id] || [];
            if (name === 'getMidiNotes') return backend.notes[id] || [];
            return [];  // getTakeWaveform: a hot clip is answered nothing
        },
    });
    notePoll({ nodes: [] }, new Map());
    function poll(nodes, vm = {}) {
        const state = { id: 'root', nodes, perf: { sampleRate: RATE } };
        const next = indexNodes(nodes);
        cache.noteGraph(facts.lastNodesById, next);
        notePoll(state, next);
        cache.refresh(state, { quantum: Q, lanes: [], ...vm });
        return cache.patchInputs(next);
    }
    const askedFor = name => backend.asked.filter(c => c[0] === name);
    return { cache, backend, poll, askedFor };
}

/* ---------- keys ---------- */

test('peakKey: the active content — length, active take, take count', () => {
    const n = committed('a');
    assert.equal(peakKey(n), peakKey({ ...n, name: 'renamed', origin: 99 }),
        'nothing but the content moves it');
    assert.notEqual(peakKey(n), peakKey({ ...n, duration: n.duration + 1 }));
    assert.notEqual(peakKey(n), peakKey({ ...n, activeTake: 1, takes: 2 }),
        'another take selected');
    assert.notEqual(peakKey({ ...n, activeTake: 1, takes: 3 }),
                    peakKey({ ...n, activeTake: 1, takes: 2 }),
        'a delete that renumbers the takes');
    assert.equal(peakKey({}), '0:0:0', 'absent fields read as 0');
});

test('midiKey: the notes\' identity includes Q', () => {
    const n = committed('m', { midiEvents: 8 });
    assert.notEqual(midiKey(n, Q), midiKey(n, Q / 2));
    assert.notEqual(midiKey(n, Q), midiKey({ ...n, midiEvents: 10 }, Q));
    assert.notEqual(midiKey(n, Q), midiKey({ ...n, activeTake: 1, takes: 2 }, Q));
});

test('capturedSamples: a first take is its duration; a new take is read off the playhead', () => {
    const node = { duration: 1234 };
    assert.equal(capturedSamples(node, undefined, Q), 1234, 'a lane the view does not list');
    assert.equal(capturedSamples(node, { retake: false }, Q), 1234);
    assert.equal(capturedSamples(node, { retake: true, recordingLengthQ: 1.5 }, Q), 1.5 * Q);
    assert.equal(capturedSamples(node, { retake: true, pendingStart: true,
                                         recordingLengthQ: 1.5 }, Q), 0,
        'armed, the slot\'s top not yet come round');
});

/* ---------- waveform peaks ---------- */

test('a committed clip\'s waveform is read once, at the density its length asks for', async () => {
    const { cache, backend, poll, askedFor } = harness();
    backend.waveforms.a = [0.2, 0.5];
    const first = poll([committed('a')]);
    assert.deepEqual([...first.pendingFetch], ['a'], 'not landed: out of the composites');
    poll([committed('a')]);  // the read is still out: not asked twice
    await cache.idle();
    assert.deepEqual(askedFor('getWaveform'), [['getWaveform', 'a', MIN_PEAKS]]);
    const after = poll([committed('a')]);
    assert.deepEqual(after.livePeaks.get('a'), [0.2, 0.5]);
    assert.equal(after.pendingFetch.size, 0);
    assert.equal(askedFor('getWaveform').length, 1, 'in hand: not read again');
});

test('an empty answer is not kept: the next poll asks again', async () => {
    const { cache, backend, poll, askedFor } = harness();
    poll([committed('a')]);  // the backend has nothing yet
    await cache.idle();
    backend.waveforms.a = [0.3];
    assert.equal(poll([committed('a')]).pendingFetch.has('a'), true);
    await cache.idle();
    assert.equal(poll([committed('a')]).pendingFetch.has('a'), false);
    assert.equal(askedFor('getWaveform').length, 2);
});

test('a take selection changes the active content: its waveform is read afresh', async () => {
    const { cache, backend, poll, askedFor } = harness();
    backend.waveforms.a = [0.3];
    poll([committed('a', { takes: 2 })]);
    await cache.idle();
    poll([committed('a', { takes: 2 })]);
    assert.equal(askedFor('getWaveform').length, 1);
    backend.waveforms.a = [0.8];
    const selected = [committed('a', { takes: 2, activeTake: 1 })];
    assert.equal(poll(selected).pendingFetch.has('a'), true,
        'the peaks in hand are the other take\'s');
    await cache.idle();
    assert.deepEqual(poll(selected).livePeaks.get('a'), [0.8]);
    assert.equal(askedFor('getWaveform').length, 2);
});

test('before a poll publishes a rate, counts are taken at the fallback rate', async () => {
    const { cache, askedFor } = harness();
    const long = committed('a', { duration: 60 * FALLBACK_SAMPLE_RATE });
    const state = { id: 'root', nodes: [long] };  // no perf
    notePoll(state, indexNodes(state.nodes));
    cache.refresh(state, { quantum: Q, lanes: [] });
    await cache.idle();
    assert.deepEqual(askedFor('getWaveform'),
        [['getWaveform', 'a', peakCountFor(long.duration, FALLBACK_SAMPLE_RATE)]]);
});

test('a recording clip accumulates live peaks by time, then the commit replaces them', async () => {
    const { cache, backend, poll } = harness();
    const rec = seconds => clip('a', { isRecording: true, duration: seconds * RATE,
                                       currentPeak: 0.5 });
    poll([rec(0.5)]);
    const inputs = poll([rec(1)]);
    const live = inputs.livePeaks.get('a');
    assert.equal(live.length, PEAKS_PER_SECOND + 1, 'one second of take, time-indexed');
    assert.equal(inputs.pendingFetch.has('a'), false, 'a growing take is not a pending fetch');

    backend.waveforms.a = [0.9, 0.8];
    assert.equal(poll([committed('a')]).pendingFetch.has('a'), true,
        'committed, its real waveform not landed: the live array must not reach a composite');
    await cache.idle();
    assert.deepEqual(poll([committed('a')]).livePeaks.get('a'), [0.9, 0.8]);
});

/* ---------- the retake inference ---------- */

test('retake inference: a committed, idle clip that goes hot is taking a new take', () => {
    const { cache, poll } = harness();
    poll([committed('slot'), clip('empty')]);
    poll([committed('slot', { isPendingStart: true }),
          clip('empty', { isPendingStart: true })]);
    assert.deepEqual([...cache.retakes], ['slot'], 'an empty clip going hot is a first take');
    poll([committed('slot', { isRecording: true }), clip('empty', { isRecording: true })]);
    assert.deepEqual([...cache.retakes], ['slot'], 'still the same take');
});

test('retake inference: a clip first seen hot is not called a retake', () => {
    const { cache, poll } = harness();
    poll([committed('slot', { isRecording: true })]);
    assert.equal(cache.retakes.size, 0);
});

test('retake inference: the clip leaves the set when it lands, or leaves the graph', () => {
    const { cache, poll } = harness();
    poll([committed('a'), committed('b')]);
    poll([committed('a', { isRecording: true }), committed('b', { isRecording: true })]);
    assert.equal(cache.retakes.size, 2);
    poll([committed('a', { takes: 2, activeTake: 1 })]);  // a landed, b was deleted
    assert.equal(cache.retakes.size, 0);
});

test('a retake\'s slot draws the take that was sounding from the peaks in hand — the backend is not asked', async () => {
    const { cache, backend, poll, askedFor } = harness();
    backend.waveforms.slot = [0.4, 0.7, 0.1];
    poll([committed('slot')]);
    await cache.idle();
    poll([committed('slot')]);
    const inputs = poll([committed('slot', { isPendingStart: true })]);
    for (let patch = 0; patch < 5; patch++) {
        assert.deepEqual(inputs.takePeaks('slot', 0), [0.4, 0.7, 0.1]);
    }
    assert.deepEqual(askedFor('getTakeWaveform'), []);
});

test('no seed from peaks that are not the sounding take\'s: the hot slot draws nothing, and is not read', async () => {
    const { cache, backend, poll, askedFor } = harness();
    backend.waveforms.slot = [0.4, 0.7];
    poll([committed('slot', { takes: 2 })]);
    await cache.idle();  // take 0's peaks are in hand
    // Take 1 is selected, and the retake starts before its waveform lands.
    poll([committed('slot', { takes: 2, activeTake: 1 })]);
    const inputs = poll([committed('slot', { takes: 2, activeTake: 1,
                                             isPendingStart: true })]);
    assert.equal(inputs.takePeaks('slot', 1), null, 'take 0\'s peaks are not take 1\'s');
    assert.deepEqual(askedFor('getTakeWaveform'), []);
});

/* ---------- pruning ---------- */

test('a node that left the graph takes its content with it; restored, it is read again', async () => {
    const { cache, backend, poll, askedFor } = harness();
    backend.waveforms.a = [0.2];
    backend.waveforms.b = [0.6];
    poll([committed('a'), committed('b')]);
    await cache.idle();
    const gone = poll([committed('a')]);
    assert.equal(gone.livePeaks.has('b'), false);
    assert.equal(gone.livePeaks.has('a'), true);
    poll([committed('a'), committed('b')]);  // an undo brings it back
    await cache.idle();
    assert.equal(askedFor('getWaveform').filter(c => c[1] === 'b').length, 2);
});

/* ---------- MIDI notes ---------- */

const midi = (id, extra = {}) =>
    committed(id, { contentKind: 'midi', midiEvents: 2, ...extra });

test('MIDI notes: read once per content, decoded to Q units with their pitch range', async () => {
    const { cache, backend, poll, askedFor } = harness();
    backend.notes.m = [[1, 2, 60, 100, 1, 4]];  // at Q/2, a quarter Q long
    poll([midi('m'), committed('audio')]);
    await cache.idle();
    const { midiNotes } = poll([midi('m'), committed('audio')]);
    assert.deepEqual(midiNotes.get('m').notes,
        [{ posQ: 0.5, note: 60, vel: 100, lenQ: 0.25 }]);
    assert.equal(midiNotes.get('m').quantum, Q);
    assert.ok(midiNotes.get('m').range.lo <= 60 && midiNotes.get('m').range.hi >= 60);
    assert.deepEqual(askedFor('getMidiNotes'), [['getMidiNotes', 'm']],
        'audio clips are never asked for notes');
});

test('MIDI notes: a Q change rescales the notes in hand at once, and refetches', async () => {
    const { cache, backend, poll, askedFor } = harness();
    backend.notes.m = [[1, 2, 60, 100, 1, 4]];
    poll([midi('m')]);
    await cache.idle();
    // Q halves (the tempo-setting take was trimmed): the same sample
    // position is twice as many Qs in.
    const { midiNotes } = poll([midi('m')], { quantum: Q / 2 });
    assert.equal(midiNotes.get('m').notes[0].posQ, 1);
    assert.equal(midiNotes.get('m').notes[0].lenQ, 0.5);
    assert.equal(askedFor('getMidiNotes').length, 2);
});

test('MIDI notes: a hot clip keeps its notes and is not asked', async () => {
    const { cache, backend, poll, askedFor } = harness();
    backend.notes.m = [[0, 1, 64, 90, 1, 1]];
    poll([midi('m')]);
    await cache.idle();
    const { midiNotes } = poll([midi('m', { isRecording: true, midiEvents: 9 })]);
    assert.equal(midiNotes.get('m').notes.length, 1);
    assert.equal(askedFor('getMidiNotes').length, 1);
});

/**
 * THE OWNER'S USUAL WORKFLOW, end to end (2026-09-10):
 *
 *   1. a 5-track drum group from a template, recorded as ONE take
 *      (five mics, five input channels) — the first take defines Q;
 *   2. the loop region pulled in FROM BOTH SIDES on that first clip
 *      (the definer's trim: Q := the window, epoch := its top);
 *   3. a bass track, a guitar track, a keys track;
 *   4. the scratch drums replaced: a NEW, much longer drum take from
 *      the same template, then edited heavily — bars cut out, an
 *      ⌥-free cut at a non-Q-aligned seam (whole-Q total), the
 *      beginning and end pulled in — while the transport plays;
 *   5. the scratch group deleted (Q survives its creator);
 *   6. sequences over all of it, in several gate combinations, with a
 *      cued step and a bypass.
 *
 * At every stage the spectral listener judges heard == law == lanes;
 * the sequences are judged by the audible truth (solo-listen) AND by
 * the listener with the gate law.
 *
 * Not in this journey (yet): the keys track as a MIDI lane — the
 * listener is audio; keys stand in as an audio track here.
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, call, state, rec, recGroup, newGroup, verifyHeard,
         findNode, listenAtTop, expectSameSound, dimmedCells, mod, ancestorsOf }
    from './engine_helpers.mjs';

const RATE = 44100;
const MICS = 5;

/** A 5-track drum group with one input per mic. */
async function drumKit(page) {
    const g = await newGroup(page);
    for (let k = 0; k < MICS; k++) {
        await call(page, 'createNode', 'clip', g);
    }
    const st = await state(page);
    const members = findNode(st, g).nodes.map(n => n.id);
    for (let k = 0; k < MICS; k++) await call(page, 'setNodeInput', members[k], k);
    await call(page, 'renameNode', g, 'Drums');
    return { g, members };
}

/** The gate law for verifyHeard: a clip is silent where its top-level
 * row is gated off in the step under `phaseQ`; seams are skipped. */
function gateLaw(st, seq, stepQ) {
    const fade = 0.010 * RATE / st.quantum;
    return (id, phaseQ) => {
        const chain = ancestorsOf(st, id);
        const row = chain.length ? chain[0].id : id;
        const total = seq.steps.length * stepQ;
        const p = mod(phaseQ, total);
        const d = Math.min(p % stepQ, stepQ - (p % stepQ));
        if (d < fade + 0.12) return 'skip';
        const step = Math.floor(p / stepQ);
        const bits = seq.gates[row];
        return bits ? !bits[step] : false;
    };
}

test('drums template → trim both sides → bass, guitar, keys → a long drum take, cut and trimmed → sequences', async ({ page }) => {
    test.setTimeout(240000);
    await openEngine(page);

    // --- 1. The drum kit, saved as a template, then created from it ---
    const kit0 = await drumKit(page);
    expect(await call(page, 'saveTrackTemplate', kit0.g, 'e2e-drums')).toBe(true);
    await call(page, 'deleteNode', kit0.g);
    expect(await call(page, 'createFromTrackTemplate', 'e2e-drums', '')).toBe(true);
    let st = await state(page);
    const scratch = st.nodes[st.nodes.length - 1].id;
    const scratchMics = findNode(st, scratch).nodes.map(n => n.id);
    expect(scratchMics.length).toBe(MICS);
    expect(scratchMics.map(id => findNode(st, id).inputChannel)).toEqual([0, 1, 2, 3, 4]);

    // The first take: 2 s of five mics — Q := 2 s for now.
    const L0 = 2 * RATE;
    await recGroup(page, scratch, L0);
    st = await state(page);
    expect(st.quantum).toBe(L0);
    for (const id of scratchMics) expect(findNode(st, id).duration).toBe(L0);
    await verifyHeard(page);

    // --- 2. Pull the loop region in from BOTH sides on the first clip ---
    // The definer stack's trim (Q13 for groups): [0.5 s, 1.5 s) → Q := 1 s,
    // epoch := origin + 0.5 s. The lanes show the raw take with the
    // selection over it; the playhead maps into the brackets.
    await engine(page, 'advance', { samples: 12345 });
    await call(page, 'setLoopPoints', scratch, L0 / 4, (3 * L0) / 4);
    st = await state(page);
    const Q = st.quantum;
    expect(Q).toBe(RATE);
    expect(st.islandEpoch).toBe(findNode(st, scratch).origin + L0 / 4);
    expect((await engine(page, 'status')).cycle).toBe(Q);
    await verifyHeard(page);

    // --- 3. Bass, guitar, keys (audio stand-in for the MIDI lane) ---
    const bass = await rec(page, 4 * Q, { atPhase: 0 });
    await call(page, 'renameNode', bass, 'Bass');
    // The second arm lock-collapsed the definer: the kit is now 1 s.
    st = await state(page);
    for (const id of scratchMics) expect(findNode(st, id).duration).toBe(Q);
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
    await verifyHeard(page);
    await engine(page, 'advance', { samples: 4 * Q + 9876 });
    const guitar = await rec(page, 4 * Q, { atPhase: 2 * Q });
    await call(page, 'renameNode', guitar, 'Guitar');
    const keys = await rec(page, 8 * Q, { atPhase: 1 * Q });
    await call(page, 'renameNode', keys, 'Keys');
    expect((await engine(page, 'status')).cycle).toBe(8 * Q);
    await verifyHeard(page);

    // --- 4. The real drums: a new kit from the template, a long take ---
    expect(await call(page, 'createFromTrackTemplate', 'e2e-drums', '')).toBe(true);
    st = await state(page);
    const drums = st.nodes[st.nodes.length - 1].id;
    const mics = findNode(st, drums).nodes.map(n => n.id);
    await engine(page, 'advance', { samples: 3 * Q + 4321 });
    await recGroup(page, drums, 16 * Q, { atPhase: 3 * Q });
    st = await state(page);
    for (const id of mics) expect(findNode(st, id).duration).toBe(16 * Q);
    expect((await engine(page, 'status')).cycle).toBe(16 * Q);
    await verifyHeard(page);

    // --- 5. The scratch kit goes: Q survives its creator ---
    await call(page, 'deleteNode', scratch);
    st = await state(page);
    expect(findNode(st, scratch)).toBeNull();
    expect(st.quantum).toBe(Q);
    expect((await engine(page, 'status')).cycle).toBe(16 * Q);
    await verifyHeard(page);

    // --- Heavy edits on the long take, while it plays ---
    // Cut bar 4 out: keep [0, 3Q) + [4Q, 16Q) (15Q).
    await engine(page, 'advance', { samples: 5 * Q + 777 });
    await call(page, 'setSegments', drums, [0, 3 * Q, 4 * Q, 16 * Q]);
    st = await state(page);
    expect(findNode(st, drums).segments).toEqual([0, 3 * Q, 4 * Q, 16 * Q]);
    await verifyHeard(page);
    // An ⌥-free cut: the seam off the grid, the TOTAL whole-Q:
    // [0, 2.5Q) + [4.5Q, 16Q) = 14Q.
    await engine(page, 'advance', { samples: 2 * Q + 100 });
    await call(page, 'setSegments', drums, [0, 2.5 * Q, 4.5 * Q, 16 * Q]);
    st = await state(page);
    expect(findNode(st, drums).segments).toEqual([0, 2.5 * Q, 4.5 * Q, 16 * Q]);
    expect((await engine(page, 'status')).cycle).toBe(lcm(14, 8) * Q);
    await verifyHeard(page);
    // Pull the beginning and the end in: [1Q, 2.5Q) + [4.5Q, 11Q) = 8Q.
    await engine(page, 'advance', { samples: 3 * Q + 55 });
    await call(page, 'setSegments', drums, [Q, 2.5 * Q, 4.5 * Q, 11 * Q]);
    st = await state(page);
    expect(findNode(st, drums).segments).toEqual([Q, 2.5 * Q, 4.5 * Q, 11 * Q]);
    expect((await engine(page, 'status')).cycle).toBe(8 * Q);
    await verifyHeard(page);
    const beforeSong = await listenAtTop(page);

    // --- 6. Sequences: four sections over the 8Q cycle, several combos ---
    st = await state(page);
    const root = st.id;
    const rows = { drums, bass, guitar, keys };
    const combos = [
        // guitar alone → drums + bass join → everything → keys alone
        { guitar: [1, 1, 1, 0], drums: [0, 1, 1, 0], bass: [0, 1, 1, 0], keys: [0, 0, 1, 1] },
        // drums alone → bass → guitar → everything
        { drums: [1, 1, 1, 1], bass: [0, 1, 1, 1], guitar: [0, 0, 1, 1], keys: [0, 0, 0, 1] },
        // everything, then nothing, then everything but drums, then keys+drums
        { drums: [1, 0, 0, 1], bass: [1, 0, 1, 0], guitar: [1, 0, 1, 0], keys: [1, 0, 1, 1] },
    ];
    const stepQ = 8;
    for (const [i, combo] of combos.entries()) {
        const gates = Object.fromEntries(
            Object.entries(combo).map(([name, bits]) => [rows[name], bits.map(Boolean)]));
        const steps = [0, 1, 2, 3].map(k => ({ name: `s${k}`, len: stepQ * Q }));
        await call(page, 'setSequence', root, { steps, gates });
        st = await state(page);
        expect(st.sequence.steps.length, `combo ${i}`).toBe(4);
        expect((await engine(page, 'status')).cycle).toBe(4 * stepQ * Q);
        // The audible truth, cell by cell, against the gate table…
        const truth = await engine(page, 'truth');
        expect(truth.cycleQ).toBe(32);
        for (const [name, bits] of Object.entries(combo)) {
            const memberIds = name === 'drums' ? mics : [rows[name]];
            for (const id of memberIds) {
                const want = [];
                for (let cell = 0; cell < 32; cell++) want.push(!!bits[Math.floor(cell / stepQ)]);
                expect(truth.truth[id], `combo ${i}: ${name} ${id.slice(0, 6)}`).toEqual(want);
                // …and the lanes dim exactly there.
                const dimmed = await dimmedCells(page, id, 32);
                expect(dimmed, `combo ${i}: ${name} lane dims`).toEqual(want.map(on => !on));
            }
        }
        // …and the listener: heard == law under the gates.
        await verifyHeard(page, { silent: gateLaw(st, st.sequence, stepQ) });
    }

    // A cued step: step 3 replays the song top; then bypass the song —
    // the plain 8Q island again, audio identical to before the song.
    const cued = [0, 1, 2, 3].map(k => ({ name: `s${k}`, len: stepQ * Q, cue: k === 2 }));
    await call(page, 'setSequence', root, { steps: cued, gates: {} });
    st = await state(page);
    expect(st.sequence.steps[2].cue).toBe(true);
    await call(page, 'toggleSequence', root);
    expect((await engine(page, 'status')).cycle).toBe(8 * Q);
    const afterSong = await listenAtTop(page);
    expectSameSound(beforeSong, afterSong, { label: 'song bypassed' });
    await verifyHeard(page);
});

function lcm(a, b) {
    const gcd = (x, y) => (y ? gcd(y, x % y) : x);
    return a / gcd(a, b) * b;
}

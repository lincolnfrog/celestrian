/**
 * mock/scenarios.js — the test scenarios, and the empty session the mock
 * boots into. A scenario is a hand-written graph built through the node
 * factory (graph_crud.js newNode), so a fixture node has every default a
 * created one has; one with committed content sets the island Q as its
 * first commit would have.
 *
 * Every length is a multiple of `Q` — one second at the mock's rate
 * (rate.js), read at LOAD time — so a scenario keeps its musical shape
 * at any rate. Set the rate before loading.
 */

import { state, transport, freshRoot, DEFAULT_SAMPLES_PER_TICK, settleAnchors } from './state.js';
import { clearUndoHistory } from './undo.js';
import { recView } from './recording.js';
import { quantumSamples } from './rate.js';
import { newNode } from './graph_crud.js';
import { ensureEffects } from './effects.js';

const clip = (id, name, duration, facts = {}) =>
    newNode('clip', { id, name, duration, ...facts });
const stack = (id, name, nodes, facts = {}) =>
    newNode('stack', { id, name, nodes, ...facts });

/**
 * Load a named scenario: a fully isolated fresh session — graph, island
 * facts, master fader and rack, clock, recording view and undo history
 * all reset before the fixture installs.
 *
 *  'empty'                     a blank session
 *  'single-clip'               one committed 2Q clip, the Q-definer
 *  'stack-with-clips'          one stack: 2Q + 3Q + 1Q
 *  'multiple-stacks'           two sibling stacks, one clip each
 *  'example-1q-4q'             1Q + 4Q under a windowed stack, playing
 *  'example-1q-4q-3q'          1Q + 4Q + 3Q (cycle 12Q)
 *  'clip-3-anchor-at-2q'       1Q, 4Q, and a 1Q clip whose origin is 2Q
 *  'nested-stacks'             a stack inside a stack
 *  '1q-3q-loop-bug'            1Q + 3Q under a windowed stack, playing
 *  'recording-1q-plus-growing' a 1Q clip and a take 2.5Q into recording
 *  'fractal-drums'             a root song over a bass and a sequenced
 *                              kit of one-shots (sequencer.md §12)
 *  'midi-clip'                 a 1Q audio seed and a 2Q MIDI clip
 *  'keys-then-drums'           a 1Q loop that set Q and a 5Q take over
 *                              it — the track to hand Q to
 */
export function loadScenario(name) {
    const Q = quantumSamples();
    transport.running = false;
    transport.speed = 1.0;
    transport.samplesPerTick = DEFAULT_SAMPLES_PER_TICK;
    recView.active = false;
    state.isPlaying = false;
    state.masterPos = 0;
    state.islandZero = 0;
    state.islandQ = 0;
    state.definerDesignation = '';
    state.nextId = 1;
    state.root = freshRoot();
    ensureEffects(state.root);
    clearUndoHistory();

    const playing = at => {
        state.isPlaying = true;
        state.masterPos = at;
    };

    switch (name) {
        case 'empty':
            break;

        case 'single-clip':
            state.islandQ = 2 * Q;
            state.nodes = [clip('clip-1', 'Recorded Clip', 2 * Q)];
            state.nextId = 2;
            break;

        case 'stack-with-clips':
            state.islandQ = Q;
            state.nodes = [stack('stack-1', 'Main Stack', [
                clip('clip-1', 'Clip A', 2 * Q),
                clip('clip-2', 'Clip B', 3 * Q),
                clip('clip-3', 'Clip C', Q),
            ])];
            state.nextId = 4;
            break;

        case 'multiple-stacks':
            state.islandQ = Q;
            state.nodes = [
                stack('stack-1', 'Stack 1', [clip('clip-1', 'Beat', 2 * Q)]),
                stack('stack-2', 'Stack 2', [clip('clip-2', 'Melody', 3 * Q)]),
            ];
            state.nextId = 3;
            break;

        case 'example-1q-4q':
            state.islandQ = Q;
            playing(0.5 * Q);
            state.nodes = [stack('stack-1', 'LCM Test Stack', [
                clip('clip-1q', 'Clip 1Q', Q, { loopEnd: Q }),
                clip('clip-4q', 'Clip 4Q', 4 * Q, { loopEnd: 4 * Q }),
            ], { loopEnd: 4 * Q })];
            state.nextId = 3;
            break;

        case 'example-1q-4q-3q':
            state.islandQ = Q;
            state.nodes = [stack('stack-1', 'Polyrhythm Stack', [
                clip('clip-1q', 'Clip 1Q', Q),
                clip('clip-4q', 'Clip 4Q', 4 * Q),
                clip('clip-3q', 'Clip 3Q', 3 * Q),
            ])];
            state.nextId = 4;
            break;

        case 'clip-3-anchor-at-2q':
            state.islandQ = Q;
            playing(2 * Q);
            state.nodes = [stack('stack-1', 'Anchor Bug Test Stack', [
                clip('clip-1', 'Clip 1Q', Q, { loopEnd: Q }),
                clip('clip-2', 'Clip 4Q', 4 * Q, { loopEnd: 4 * Q }),
                clip('clip-3', 'Clip 1Q@2Q', Q, { loopEnd: Q, origin: 2 * Q }),
            ])];
            state.nextId = 4;
            break;

        case 'nested-stacks':
            state.islandQ = Q;
            playing(0.5 * Q);
            state.nodes = [stack('parent-stack', 'Parent Stack', [
                clip('clip-1', 'Top Level Clip', Q),
                stack('child-stack', 'Nested Stack', [
                    clip('nested-clip-1', 'Nested Clip A', 2 * Q),
                    clip('nested-clip-2', 'Nested Clip B', Q),
                ]),
            ])];
            state.nextId = 10;
            break;

        case '1q-3q-loop-bug':
            state.islandQ = Q;
            playing(0);
            state.nodes = [stack('stack-1', 'Loop Bug Test Stack', [
                clip('clip-1q', 'Clip 1Q', Q, { loopEnd: Q }),
                clip('clip-3q', 'Clip 3Q', 3 * Q, { loopEnd: 3 * Q }),
            ], { loopEnd: 3 * Q })];
            state.nextId = 3;
            break;

        case 'fractal-drums':
            state.islandQ = Q;
            state.isPlaying = true;
            state.nodes = [
                clip('bass', 'Bass', 4 * Q, { loopEnd: 4 * Q, contextCycle: 4 * Q }),
                stack('drums', 'Drums', ['kick', 'snare', 'hat'].map(id =>
                    clip(id, id[0].toUpperCase() + id.slice(1), Q,
                        { loopEnd: Q, periodSource: 'context', contextCycle: 4 * Q })), {
                    sequence: {
                        steps: [1, 2, 3, 4].map(i => ({ name: String(i), len: Q })),
                        gates: { kick: [true, false, true, false],
                                 snare: [false, true, false, true] },
                    },
                }),
            ];
            state.root.sequence = {
                steps: [{ name: 'intro', len: 4 * Q }, { name: 'full', len: 4 * Q }],
                gates: { drums: [false, true] },
            };
            state.nextId = 10;
            break;

        case 'midi-clip':
            // The MIDI clip's events are [pos, status, data1, data2]: an
            // arpeggio over the first bar, one note held into the second,
            // one note-on left open.
            state.islandQ = Q;
            state.nodes = [
                clip('seed', 'Seed', Q, { loopEnd: Q }),
                clip('midi-1', 'Keys', 2 * Q, {
                    loopEnd: 2 * Q, contentKind: 'midi', midiEvents: 7,
                    midi: [
                        [0, 0x90, 60, 100], [Q / 4, 0x80, 60, 0],
                        [Q / 4, 0x90, 64, 90], [Q / 2, 0x80, 64, 0],
                        [Q / 2, 0x90, 67, 80], [1.25 * Q, 0x80, 67, 0],
                        [1.5 * Q, 0x90, 72, 110],
                    ],
                }),
            ];
            state.nextId = 3;
            break;

        case 'keys-then-drums':
            state.islandQ = Q;
            state.nodes = [
                clip('keys', 'Keys', Q),
                clip('drums', 'Drums', 5 * Q, { origin: 2 * Q, inputChannel: 1 }),
            ];
            state.nextId = 3;
            break;

        case 'recording-1q-plus-growing':
            state.islandQ = Q;
            playing(2.5 * Q);
            state.nodes = [stack('stack-1', 'Recording Test Stack', [
                clip('clip-1', 'New Clip', Q, { loopEnd: Q }),
                clip('clip-2', 'New Clip', 2.5 * Q,
                    { isRecording: true, currentPeak: 0.002, loopEnd: 2.5 * Q }),
            ])];
            state.nextId = 3;
            break;

        default:
            console.warn('[MockBackend] Unknown scenario:', name);
    }
    // A fixture carries no stack origins: each stack anchors from its
    // content, as its first content would have anchored it.
    settleAnchors();
}

loadScenario('empty');

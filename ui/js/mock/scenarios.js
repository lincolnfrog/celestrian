/**
 * mock/scenarios.js — test scenario loaders (and the 'empty' boot).
 * Scenario graphs are hand-written fixtures in the CURRENT state shape:
 * every scenario with committed content sets the STORED island Q
 * (`state.islandQ`, published as `quantum`) the way a real first
 * commit would — the mock has no derivation fallback.
 * makeClip/makeStack collapse the repeated literals.
 *
 * SAMPLE RATE: every fixture length below is a multiple of `Q` — one
 * second of audio at the mock's rate (mock/rate.js) — read at LOAD
 * time, so a scenario keeps its musical shape (1Q + 3Q, LCM 3Q, a take
 * 2.5Q in) at any rate.
 */

import { state, settleAnchors } from './state.js';
import { clearUndoHistory } from './undo.js';
import { transport, DEFAULT_SAMPLES_PER_TICK } from './transport.js';
import { recView } from './recording.js';
import { quantumSamples } from './rate.js';

/** Clip fixture factory: the invariant base every scenario clip shares;
 * `overrides` supplies the rest and NOTHING is added beyond it. */
function makeClip(overrides) {
    return { type: 'clip', ...overrides };
}

/** Stack fixture factory — same contract as makeClip. */
function makeStack(overrides) {
    return { type: 'stack', effectiveQuantum: quantumSamples(), ...overrides };
}

// The full at-rest flag block older fixtures spell out on every clip.
const IDLE_FLAGS = { isRecording: false, isPlaying: false,
                     isMuted: false, isSoloed: false };

/**
 * Load a named test scenario into the state singleton.
 *
 * Contract: a scenario load is a FULLY ISOLATED fresh session — the
 * graph, island facts (Q, epoch), master fader, transport clock
 * (isPlaying + masterPos), recording view base, and undo history all
 * reset before the fixture installs; scenarios that stage a running
 * transport re-assert isPlaying/masterPos in their own case.
 *
 * Scenario index:
 *  - 'empty'                     — blank session
 *  - 'single-clip'               — one committed 2 s clip (Q13 definer)
 *  - 'stack-with-clips'          — one stack, three committed clips
 *  - 'multiple-stacks'           — two sibling stacks, one clip each
 *  - 'example-1q-4q'             — recording.md example 1 (LCM = 4Q)
 *  - 'example-1q-4q-3q'          — recording.md example 2 (LCM = 12Q)
 *  - 'clip-3-anchor-at-2q'       — anchor bug repro (origin at 2Q)
 *  - 'nested-stacks'             — stack inside a stack
 *  - '1q-3q-loop-bug'            — loop region bug repro (collapse + trim)
 *  - 'recording-1q-plus-growing' — live take growing past 2.5Q
 *  - 'fractal-drums'             — root song over bass + a sequenced
 *                                  one-shot drum kit (sequencer.md §12)
 */
export function loadScenario(name) {
    console.log('[MockBackend] Loading scenario:', name);
    state.nextId = 1;

    // The fixture quantum: 1 s of audio at the mock's CURRENT rate
    // (read here, not at module load, so setSampleRate before a load
    // re-rates the fixtures). Historically the literal 44100.
    const Q = quantumSamples();

    // Reset transport simulation on scenario load
    transport.running = false;
    transport.speed = 1.0;
    transport.samplesPerTick = DEFAULT_SAMPLES_PER_TICK;  // simulation step
    recView.active = false;
    // Scenario isolation: the clock resets too — isPlaying/masterPos
    // must not leak in from whatever the previous test left running
    // (transport.running is already false, above).
    state.isPlaying = false;
    state.masterPos = 0;
    state.islandEpoch = 0;
    state.islandQ = 0;  // fresh session: Q re-establishes per scenario
    state.masterGain = 1;  // master fader back to unity (test isolation)
    state.rootSequence = null;        // the root song (sequencer.md)
    state.rootSequenceBypassed = false;
    state.rootAuditionStep = -1;
    // Loading a scenario is a fresh session — undo history does not carry
    // across it (test isolation + mirrors constructing a fresh engine).
    clearUndoHistory();

    switch (name) {
        case 'empty':
            state.nodes = [];
            break;

        case 'single-clip':
            // One committed 2 s take — the SOLE clip, so it is the Q13
            // definer: a first commit stores Q = its own duration.
            state.islandQ = 2 * Q;
            state.nodes = [makeClip({
                id: 'clip-1',
                name: 'Recorded Clip',
                duration: 2 * Q,
                ...IDLE_FLAGS,
                effectiveQuantum: 2 * Q,
                inputChannel: 0,
            })];
            state.nextId = 2;
            break;

        case 'stack-with-clips':
            // 2Q + 3Q + 1Q under one stack (LCM 6Q); Q = 1 s.
            state.islandQ = Q;
            state.nodes = [makeStack({
                id: 'stack-1',
                name: 'Main Stack',
                effectiveQuantum: Q,
                nodes: [
                    makeClip({
                        id: 'clip-1',
                        name: 'Clip A',
                        duration: 2 * Q,
                        loopStart: 0,  // Match native C++ backend defaults
                        loopEnd: 0,    // Match native C++ backend defaults (triggers bug!)
                        ...IDLE_FLAGS,
                        effectiveQuantum: Q,
                        inputChannel: 0,
                    }),
                    makeClip({
                        id: 'clip-2',
                        name: 'Clip B',
                        duration: 3 * Q,
                        loopStart: 0,
                        loopEnd: 0,
                        ...IDLE_FLAGS,
                        effectiveQuantum: Q,
                        inputChannel: 0,
                    }),
                    makeClip({
                        id: 'clip-3',
                        name: 'Clip C',
                        duration: Q,
                        loopStart: 0,
                        loopEnd: 0,
                        ...IDLE_FLAGS,
                        effectiveQuantum: Q,
                        inputChannel: 0,
                    }),
                ],
            })];
            state.nextId = 4;
            break;

        case 'multiple-stacks':
            // Two sibling stacks, a 2Q beat and a 3Q melody; Q = 1 s.
            state.islandQ = Q;
            state.nodes = [
                makeStack({
                    id: 'stack-1',
                    name: 'Stack 1',
                    effectiveQuantum: Q,
                    nodes: [
                        makeClip({
                            id: 'clip-1',
                            name: 'Beat',
                            duration: 2 * Q,
                            effectiveQuantum: Q,
                        }),
                    ],
                }),
                makeStack({
                    id: 'stack-2',
                    name: 'Stack 2',
                    effectiveQuantum: Q,
                    nodes: [
                        makeClip({
                            id: 'clip-2',
                            name: 'Melody',
                            duration: 3 * Q,
                            effectiveQuantum: Q,
                        }),
                    ],
                }),
            ];
            state.nextId = 3;
            break;

        // ========================================
        // Recording.md Example Scenarios
        // ========================================

        // Example 1: 1Q + 4Q (LCM = 4Q)
        // Expected: Clip 1 (1Q) should have 3 ghosts, Clip 2 (4Q) should have 0 ghosts
        case 'example-1q-4q':
            state.islandQ = Q;
            state.isPlaying = true;
            state.masterPos = 0.5 * Q;  // 0.5Q into the timeline
            state.nodes = [makeStack({
                id: 'stack-1',
                name: 'LCM Test Stack',
                effectiveQuantum: Q,     // the island quantum (1 s of audio)
                loopStart: 0,            // Stack-level loop points (for collapsed mode)
                loopEnd: 4 * Q,          // Full LCM duration (4Q)
                nodes: [
                    makeClip({
                        id: 'clip-1q',
                        name: 'Clip 1Q',
                        duration: Q,             // 1Q
                        effectiveQuantum: Q,
                        isRecording: false,
                        isPlaying: true,
                        playhead: 0.5,  // 50% through the clip
                        loopStart: 0,
                        loopEnd: Q,
                    }),
                    makeClip({
                        id: 'clip-4q',
                        name: 'Clip 4Q',
                        duration: 4 * Q,         // 4Q
                        effectiveQuantum: Q,
                        isRecording: false,
                        isPlaying: true,
                        playhead: 0.125,  // 12.5% through the clip (= 0.5Q / 4Q)
                        loopStart: 0,
                        loopEnd: 4 * Q,
                    }),
                ],
            })];
            state.nextId = 3;
            break;

        // Example 2: 1Q + 4Q + 3Q (LCM = 12Q)
        // Expected: Clip 1 has 11 ghosts, Clip 2 has 2 ghosts, Clip 3 has 3 ghosts
        case 'example-1q-4q-3q':
            state.islandQ = Q;
            state.nodes = [makeStack({
                id: 'stack-1',
                name: 'Polyrhythm Stack',
                nodes: [
                    makeClip({
                        id: 'clip-1q',
                        name: 'Clip 1Q',
                        duration: Q,
                        effectiveQuantum: Q,
                        isRecording: false,
                    }),
                    makeClip({
                        id: 'clip-4q',
                        name: 'Clip 4Q',
                        duration: 4 * Q,
                        effectiveQuantum: Q,
                        isRecording: false,
                    }),
                    makeClip({
                        id: 'clip-3q',
                        name: 'Clip 3Q',
                        duration: 3 * Q,
                        effectiveQuantum: Q,
                        isRecording: false,
                    }),
                ],
            })];
            state.nextId = 4;
            break;

        case 'clip-3-anchor-at-2q':
            // ========================================
            // Clip 3 Anchor Bug Test Scenario
            // ========================================
            // Scenario: Clip 1 = 1Q, Clip 2 = 4Q, Clip 3 = 1Q at 2Q
            // Expected: Clip 3 x=400 (2Q slot), ghosts wrap at 0Q→2Q
            state.islandQ = Q;
            state.isPlaying = true;
            state.masterPos = 2 * Q;    // 2Q in samples
            state.nodes = [makeStack({
                id: 'stack-1',
                name: 'Anchor Bug Test Stack',
                effectiveQuantum: Q,     // the island quantum (1 s of audio)
                nodes: [
                    makeClip({
                        id: 'clip-1',
                        name: 'Clip 1Q',
                        duration: Q,             // 1Q
                        effectiveQuantum: Q,
                        isRecording: false,
                        isPlaying: true,
                        loopStart: 0,
                        loopEnd: Q,
                        origin: 0,
                    }),
                    makeClip({
                        id: 'clip-2',
                        name: 'Clip 4Q',
                        duration: 4 * Q,         // 4Q
                        effectiveQuantum: Q,
                        isRecording: false,
                        isPlaying: true,
                        loopStart: 0,
                        loopEnd: 4 * Q,
                        origin: 0,
                    }),
                    makeClip({
                        id: 'clip-3',
                        name: 'Clip 1Q@2Q',
                        duration: Q,             // 1Q
                        effectiveQuantum: Q,
                        isRecording: false,
                        isPlaying: true,
                        loopStart: 0,
                        loopEnd: Q,
                        origin: 2 * Q,           // KEY: started at 2Q (slot 2 derives from this)
                    }),
                ],
            })];
            state.nextId = 4;
            break;

        case 'nested-stacks':
            // ========================================
            // Nested Stacks Scenario
            // ========================================
            state.islandQ = Q;
            state.isPlaying = true;
            state.masterPos = 0.5 * Q;
            state.nodes = [makeStack({
                id: 'parent-stack',
                name: 'Parent Stack',
                nodes: [
                    makeClip({
                        id: 'clip-1',
                        name: 'Top Level Clip',
                        duration: Q,
                        effectiveQuantum: Q,
                        isRecording: false,
                        isPlaying: true,
                    }),
                    makeStack({
                        id: 'child-stack',
                        name: 'Nested Stack',
                        nodes: [
                            makeClip({
                                id: 'nested-clip-1',
                                name: 'Nested Clip A',
                                duration: 2 * Q,
                                effectiveQuantum: Q,
                                isRecording: false,
                                isPlaying: true,
                            }),
                            makeClip({
                                id: 'nested-clip-2',
                                name: 'Nested Clip B',
                                duration: Q,
                                effectiveQuantum: Q,
                                isRecording: false,
                                isPlaying: true,
                            }),
                        ],
                    }),
                ],
            })];
            state.nextId = 10;
            break;

        // ========================================
        // Loop Region Bug Test Scenario
        // ========================================
        // Reproduces bug: 1Q + 3Q clips, collapse, modify loop to 0-2Q
        // Bug: Loop alternates between 1Q and 2Q instead of consistent 2Q
        case '1q-3q-loop-bug':
            state.islandQ = Q;
            state.isPlaying = true;
            state.masterPos = 0;
            state.nodes = [makeStack({
                id: 'stack-1',
                name: 'Loop Bug Test Stack',
                effectiveQuantum: Q,     // the island quantum (1 s of audio)
                loopStart: 0,
                loopEnd: 3 * Q,          // Full LCM = 3Q
                nodes: [
                    makeClip({
                        id: 'clip-1q',
                        name: 'Clip 1Q',
                        duration: Q,             // 1Q
                        effectiveQuantum: Q,
                        isRecording: false,
                        isPlaying: true,
                        playhead: 0,
                        loopStart: 0,
                        loopEnd: Q,
                    }),
                    makeClip({
                        id: 'clip-3q',
                        name: 'Clip 3Q',
                        duration: 3 * Q,         // 3Q
                        effectiveQuantum: Q,
                        isRecording: false,
                        isPlaying: true,
                        playhead: 0,
                        loopStart: 0,
                        loopEnd: 3 * Q,
                    }),
                ],
            })];
            state.nextId = 3;
            break;

        case 'fractal-drums':
            // THE FRACTAL DRUM DEMO (docs/sequencer.md §12, mockup round
            // 2 §4): a root song (intro 4Q | full 4Q) over a 4Q bass and
            // a sequenced Drums kit — three 1Q one-shot hits under the
            // kit's own 4 × 1Q pattern. The root gates Drums off in the
            // intro. "A stack is a drum machine to its children and a
            // track to its parent."
            state.islandQ = Q;
            state.isPlaying = true;
            state.nodes = [
                makeClip({
                    id: 'bass', name: 'Bass', duration: 4 * Q, origin: 0,
                    effectiveQuantum: Q, ...IDLE_FLAGS, isPlaying: true,
                    loopStart: 0, loopEnd: 4 * Q, contextCycle: 4 * Q,
                }),
                makeStack({
                    id: 'drums', name: 'Drums',
                    sequence: {
                        steps: [1, 2, 3, 4].map(i => ({ name: String(i), len: Q })),
                        gates: { kick: [true, false, true, false],
                                 snare: [false, true, false, true] },
                    },
                    sequenceBypassed: false,
                    nodes: ['kick', 'snare', 'hat'].map((id, i) => makeClip({
                        id, name: id[0].toUpperCase() + id.slice(1),
                        duration: Q, origin: 0, effectiveQuantum: Q,
                        ...IDLE_FLAGS, isPlaying: true,
                        loopStart: 0, loopEnd: Q, periodSource: 'context',
                        contextCycle: 4 * Q,
                    })),
                }),
            ];
            state.rootSequence = {
                steps: [{ name: 'intro', len: 4 * Q }, { name: 'full', len: 4 * Q }],
                gates: { drums: [false, true] },
            };
            state.rootSequenceBypassed = false;
            state.nextId = 10;
            break;

        case 'recording-1q-plus-growing':
            // Recording Scenario (for ghost testing)
            // ========================================
            // Simulates: Clip 1 = 1Q committed, Clip 2 = actively recording at ~2.5Q
            state.islandQ = Q;
            state.isPlaying = true;
            state.masterPos = 2.5 * Q;  // 2.5Q in samples
            state.nodes = [makeStack({
                id: 'stack-1',
                name: 'Recording Test Stack',
                nodes: [
                    makeClip({
                        id: 'clip-1',
                        name: 'New Clip',
                        duration: Q,             // 1Q
                        effectiveQuantum: Q,
                        isRecording: false,
                        isPlaying: true,
                        playhead: 0.5,
                        loopStart: 0,
                        loopEnd: Q,
                    }),
                    makeClip({
                        id: 'clip-2',
                        name: 'New Clip',
                        duration: 2.5 * Q,       // 2.5Q — recording
                        effectiveQuantum: Q,
                        isRecording: true,
                        isPlaying: false,
                        currentPeak: 0.002,
                        loopStart: 0,
                        loopEnd: 2.5 * Q,
                    }),
                ],
            })];
            state.nextId = 3;
            break;

        default:
            console.warn('[MockBackend] Unknown scenario:', name);
    }
    // Q18 (engine parity: a loaded session anchors its stacks from
    // content): hand-written fixtures carry no stack origins — every
    // stack holding committed content anchors at its earliest
    // committed descendant's origin, exactly as the first content
    // would have anchored it live.
    settleAnchors();
}

// Boot EMPTY (Q17 parity): the creation menu is the instrument path
// and `R` on an empty project creates + arms the default track, so no
// seeded "Track 1" and no auto-loaded template. Tests reset with
// loadScenario(...).
loadScenario('empty');

// Celestrian app shell (docs/session_view.md): backend poll → pure view
// model → thin DOM patch. This file derives and patches the frame, runs
// the poll loop, wires the keyboard and the chrome, and hands the
// session view its callback table. What the callbacks do lives beside
// it, each module handed the bridge through shell_io.js:
//
//   session_facts.js   what the last poll published; graph predicates
//   content_cache.js   peaks, take peaks and their retake seed, MIDI notes
//   edit_verdict.js    geometry commits and whether they landed
//   record_verbs.js    ●, R, Space
//   structure_verbs.js create-and-select, group, ungroup, move
//   lane_verbs.js      a lane's own controls, undo / redo
//   project_menu.js    project identity, the Project menu, import, bounce
//
// A verb's status line is read off the engine's answer (shell_io.js
// `call`): what was done, or what was not.
//
// backend.js picks the backend; view_model.js holds the timeline math;
// session_view.js is the grid's DOM.

import { callNative, log, getState } from './backend.js';
import { deriveViewModel, hasInstrument } from './view_model.js';
import { initSessionView, patchSessionView, mapDragPinQ, mapDragPinFoldQ,
         mapDragPinZero, activeSelectedId, selection, selectWhenPresent,
         reseatOptions, noteReseat, reseatInMotion,
         pendingEditsFor, clearAllPendingEdits, isGestureLive, setRenderer }
    from './session_view.js';
import { initPreferences, patchCalibrateButton } from './preferences.js';
import { initPluginPanel } from './plugin_panel.js';
import { initMasterMeters, initMasterFader, updateMasterMonitor }
    from './vu_meter.js';
import { registerKey, SCOPE, ANY_MODIFIERS } from './keys.js';
import { foldedStacks, toggleFolded } from './view_prefs.js';
import { DEBUG } from './debug_flags.js';
import { notePlayStart, notePlayStartTransport } from './play_start.js';
import { seekDelta, seekApplied } from './seek.js';
import { createShellIo, NO_ANSWER } from './shell_io.js';
import { lastState, lastNodesById, lastRootId, lastFrame, notePoll,
         noteView, noteFrame, indexNodes, isHotClip } from './session_facts.js';
import { createContentCache } from './content_cache.js';
import { createEditVerdict } from './edit_verdict.js';
import { createStructureVerbs } from './structure_verbs.js';
import { createRecordVerbs } from './record_verbs.js';
import { createLaneVerbs } from './lane_verbs.js';
import { createProjectMenu } from './project_menu.js';

const POLL_MS = 50;  // graph-state poll cadence

/** Write the status strip's one-line log. */
function setLogLine(msg) {
    const line = document.getElementById('log-line');
    if (line) line.textContent = msg;
}

const io = createShellIo({ callNative, getState, setLogLine });
const { call, readState } = io;
const content = createContentCache({
    callNative, debugLog: DEBUG ? log : undefined });
const verdict = createEditVerdict({
    io, isGestureLive, clearPendingEdits: clearAllPendingEdits,
    trace: DEBUG ? log : null });
const structure = createStructureVerbs({ io, selectWhenPresent });
const lane = createLaneVerbs({ io, dropStaleEdits: verdict.dropStale });
const project = createProjectMenu({
    io, createAndSelect: structure.createAndSelect,
    soleSelectedId: () => selection.size === 1 ? activeSelectedId() : null });
/** Is the clip's live take a NEW TAKE of a committed slot? The slot's
 * period is published as `periodQ` while the take is armed or capturing;
 * a first take publishes none. */
function isRetake(id) {
    const n = lastNodesById.get(id);
    return !!n && isHotClip(n) && !!n.periodQ && n.periodQ.num > 0;
}
const record = createRecordVerbs({ io, isRetake, projectId: project.id });

/* ---------- view state (never sent to the engine) ---------- */
const fxOpen = new Set();    // lanes with the effects row expanded
const seqOpen = new Set();   // stacks with the sequencer grid expanded
const compMode = new Set();  // clips in comp mode (docs/takes.md)

const toggleIn = (set, id) => { if (!set.delete(id)) set.add(id); };

/** Comp mode for one lane; a null id closes every lane's (Escape). */
function onCompMode(id, open) {
    if (id === null) { compMode.clear(); return; }
    if (open) compMode.add(id); else compMode.delete(id);
    setLogLine(open
        ? 'Comp: click a Q cell to cycle which take sounds there (⌘Z undoes each)'
        : 'Comp closed — the comp stays');
}

/** The effects row. The engine hears of it only as the scope gate:
 * with no row watching, the audio thread copies nothing. */
function onToggleFx(id) {
    toggleIn(fxOpen, id);
    callNative('setEffectScope', id, fxOpen.has(id));
}

/* ---------- chrome wiring ---------- */
function wireChrome() {
    document.getElementById('dump-state-btn').addEventListener('click', async () => {
        const state = await readState();
        if (!state) { setLogLine(NO_ANSWER); return; }
        await call('dumpStateToFile', [JSON.stringify(state, null, 2)],
            'State dumped to celestrian_state.json',
            'State not dumped — the file could not be written');
    });
    initPreferences(callNative, setLogLine);
    initPluginPanel(callNative, setLogLine);

    // The root has no rail: its sequencer chip sits by the ruler and its
    // fx chip in the master strip. Stacks apply gain·pan at their
    // output, so the root's fader is the master fader.
    const onRoot = (id, fn) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => { if (lastRootId) fn(lastRootId); });
    };
    onRoot('root-seq-btn', id => toggleIn(seqOpen, id));
    onRoot('master-fx-btn', onToggleFx);
    initMasterFader(v => { if (lastRootId) callNative('setNodeGain', lastRootId, v); });
    initMasterMeters();
}

/* ---------- MIDI target follows selection ---------- */
/**
 * The keyboard plays the SELECTED instrument track; there is no
 * separate toggle. Reconciled every poll: the target is a MIDI take in
 * progress when there is one (the performer is playing into it), else
 * the selected lane when its chain carries an instrument. Anything else
 * selected keeps the last target, so tweaking another track never
 * silences the keys. One bridge call per change, none while one is out.
 */
let midiTargetPending = null;
function syncMidiTarget() {
    let desired = null;
    for (const n of lastNodesById.values()) {
        if (n.contentKind === 'midi' && (n.isRecording || n.isPendingStart)) {
            desired = n.id;
            break;
        }
    }
    if (!desired) {
        const sel = lastNodesById.get(activeSelectedId());
        if (hasInstrument(sel)) desired = sel.id;
    }
    if (!desired) { midiTargetPending = null; return; }
    if (lastNodesById.get(desired).midiArmed) { midiTargetPending = null; return; }
    if (midiTargetPending === desired) return;
    midiTargetPending = desired;
    // A lost call (null) is asked again on the next poll.
    callNative('setMidiArmed', desired, true).then(answer => {
        if (answer === null && midiTargetPending === desired) {
            midiTargetPending = null;
        }
    });
}

/* ---------- the render ---------- */
// The patch inputs the last poll built. A re-render between polls
// (renderNow) derives from the last polled state and these, never from
// a poll of its own.
let lastAux = null;
let reseatRaf = 0;  // the re-seat tween's pending animation frame

/** prefers-reduced-motion: a re-seat jumps instead of moving. */
function prefersReducedMotion() {
    try {
        return !!(window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
        return false;
    }
}

/** The frame facts (session_facts.js lastFrame) of a derived view. */
function frameFactsOf(state, vm) {
    if (!vm.qEstablished || !Number.isFinite(vm.frameZero) ||
        !Number.isFinite(state.islandPos)) return null;
    return {
        zero: vm.frameZero,
        rest: vm.restZero,
        seat: Number.isFinite(vm.seatedZero) ? vm.seatedZero : vm.frameZero,
        rawClock: state.islandPos + (state.islandZero ?? 0),
        loopSamples: (vm.loopCycleQ > 0 ? vm.loopCycleQ : vm.cycleQ) * vm.quantum,
        quantum: vm.quantum,
    };
}

/**
 * Derive the view model from `state` with everything the VIEW layers
 * over the engine's facts: the fold / fx / sequencer / comp view state,
 * the drag pin, the re-seat tween (reseat_tween.js) and a gesture's
 * pending preview (pending_edits.js). Outside a live drag the frame
 * rests on the seat, so an edit realigns the view at once — drawn as a
 * short move when the seat itself moves, never under a hand: the derive
 * that would have jumped is derived again from the move's first step.
 */
function deriveFrame(state) {
    const now = performance.now();
    const rootFrame = state.islandZero ?? state.origin ?? 0;
    const pendingEdits = pendingEditsFor(id => lastNodesById.get(id),
                                         rootFrame, now);
    const motion = {
        now,
        islandId: state.id || '',
        handDown: isGestureLive() || mapDragPinQ() !== null,
        reducedMotion: prefersReducedMotion(),
        hidden: !!document.hidden,
    };
    const derive = () => deriveViewModel(state,
        { folded: foldedStacks(project.id()),
          fxOpen, seqOpen, compMode,
          pinFrameQ: mapDragPinQ(),
          pinFoldQ: mapDragPinFoldQ(),
          pinZero: mapDragPinZero(),
          reseat: reseatOptions(motion),
          pendingEdits });
    let vm = derive();
    if (noteReseat(vm, motion)) {
        vm = derive();
        noteReseat(vm, motion);
    }
    noteView(vm, frameFactsOf(state, vm));
    return vm;
}

/** Patch the view from `vm`; while a re-seat tween runs, derive and
 * patch again once per animation frame until it lands. */
function patchFrame(vm, aux) {
    patchSessionView(vm, Object.assign({}, aux, {
        vmQuantum: vm.quantum,
        frameZero: vm.frameZero,  // composites are placed from it
    }));
    if (reseatInMotion() && !reseatRaf) {
        reseatRaf = requestAnimationFrame(() => {
            reseatRaf = 0;
            renderNow();
        });
    }
}

/**
 * requestRender's renderer (session_view/render_request.js): derive
 * from the LAST polled state — pins, the re-seat tween and pending
 * edits as they are now — and patch at once. `rerender` tells the
 * playhead's dead-reckoner to take the frame's move, not the stale
 * clock (animator.js).
 */
function renderNow() {
    if (!lastState || !lastAux) return;
    try {
        patchFrame(deriveFrame(lastState), { ...lastAux, rerender: true });
    } catch (err) {
        console.error('Render error:', err);
    }
}

/* ---------- polling ---------- */

/** One poll: adopt `state`, derive, bring the content up to it, patch. */
function poll(state) {
    const nodesById = indexNodes(state.nodes);
    verdict.noteGraph(nodesById);
    content.noteGraph(lastNodesById, nodesById);
    notePoll(state, nodesById);
    const vm = deriveFrame(state);
    content.refresh(state, vm);
    notePlayStartTransport(state.isPlaying, vm.qEstablished, lastFrame);
    record.settlePendingPause(state);
    lastAux = {
        ...content.patchInputs(nodesById),
        nodesById,
        sampleRate: state.perf ? state.perf.sampleRate : 0,
    };
    patchFrame(vm, lastAux);
    patchCalibrateButton(state.perf);
    syncMidiTarget();
    updateMasterMonitor(state, vm.rootGain);
}

/** The render loop; never returns. One bad poll is logged and the loop
 * goes on. */
async function startPolling() {
    console.log(`Starting state polling loop (${getState ? 'MOCK BACKEND' : 'JUCE BRIDGE'})...`);
    while (true) {
        try {
            const state = await readState();
            if (state) poll(state);
        } catch (err) {
            console.error('Polling error:', err);
        }
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

/* ---------- keyboard ---------- */

/** The app-scope hotkeys (keys.js): transport, undo / redo, project
 * save / open. */
function wireKeyboard() {
    const app = spec => registerKey({ scope: SCOPE.APP, ...spec });
    const prevented = fn => e => { e.preventDefault(); fn(); };
    app({ code: 'Space', ignore: ANY_MODIFIERS, handler: prevented(record.onSpace) });
    // Held, undo and redo step through the log (lane_verbs.js step);
    // the toggles around them act once per press.
    const step = verb => prevented(() => lane.step(verb));
    app({ key: 'z', modifiers: ['primary'], repeat: true, handler: step('undo') });
    app({ key: 'z', modifiers: ['primary', 'shift'], repeat: true, handler: step('redo') });
    app({ key: 'y', modifiers: ['ctrl'], repeat: true, handler: step('redo') });
    app({ key: 's', modifiers: ['primary'], handler: prevented(project.save) });
    app({ key: 'o', modifiers: ['primary'], handler: prevented(project.openWithDialog) });
}

/* ---------- the session view's callbacks ---------- */
function initApp() {
    initSessionView({
        onTogglePlay: record.togglePlay,
        // Ruler scrub: `samples` is the target phase. The engine takes
        // the advance that lands it (seek.js). Streams while dragging,
        // faster than the poll, so each applied seek is folded into the
        // frame facts for the next one. A landed seek is also the new
        // play start (play_start.js). Not undoable.
        onSeek: async samples => {
            const delta = seekDelta(samples, lastFrame);
            if (delta === null) return;
            const result = await callNative('seekTransport', delta, lastFrame.rawClock);
            if (!result) {
                // Refused: takes place audio by the clock's phase.
                if (result === false && await io.takeLiveNow()) {
                    setLogLine('The playhead stays — a take is live');
                }
                return;
            }
            noteFrame(seekApplied(lastFrame, result));
            notePlayStart(project.id(), samples);
        },
        // Fold is view state: the next poll derives from the folded set.
        onFold: id => toggleFolded(project.id(), id),
        onMute: id => callNative('toggleMute', id),
        onSolo: id => callNative('toggleSolo', id),

        // Structure. Undo is the safety net: no confirm on delete.
        onAddTrack: () => structure.createTrack(''),
        onAddClip: groupId => structure.createTrack(groupId),
        onDropLane: structure.onDropLane,
        onGroupSelection: structure.onGroupSelection,
        onMoveToTop: structure.onMoveToTop,
        onUngroup: structure.onUngroup,
        onDelete: lane.onDelete,
        onRename: lane.onRename,

        // Menu data, read per open so a fresh save or a hot-plugged
        // device appears without a reload.
        getTrackTemplates: async () => {
            const templates = await callNative('listTrackTemplates');
            return Array.isArray(templates) ? templates : [];
        },
        getKnownPlugins: async () => await callNative('getKnownPlugins') || [],
        getInputs: async () => {
            const r = await callNative('getInputList');
            return (r && r.inputs) || [];
        },
        onCreateFromTemplate: (name, groupId) => structure.createAndSelect(() =>
            call('createFromTrackTemplate', [name, groupId || ''],
                `"${name}" added — named and routed (⌘Z undoes it whole)`,
                `Template "${name}" failed to load`)),
        onSaveTemplate: (id, name) =>
            call('saveTrackTemplate', [id, name],
                `Template "${name}" saved — it's on every + menu now`,
                'Template save failed'),

        // Geometry: each commit is followed by its verdict.
        onSetWindow: verdict.onSetWindow,
        onSetSegments: verdict.onSetSegments,
        onSetTiming: verdict.onSetTiming,
        onCancelGesture: verdict.onCancelGesture,
        onSetDefiner: verdict.onSetDefiner,
        onToggleWindow: lane.onToggleWindow,
        onSetPeriodSource: lane.onSetPeriodSource,

        // Input and mixer. Pan and gain are knobs: they stream while
        // dragging and are not undoable.
        onSetInput: lane.onSetInput,
        onSetInputRight: lane.onSetInputRight,
        onMonitor: lane.onMonitor,
        onSetPan: (id, pan) => callNative('setNodePan', id, pan),
        onSetGain: (id, gain) => callNative('setNodeGain', id, gain),

        // Effects (docs/vst3.md).
        onToggleFx,
        onSetSlotEnabled: lane.onSetSlotEnabled,
        onSetSlotParam: (id, slotUuid, key, value) =>
            callNative('setSlotParam', id, slotUuid, key, value),
        onAddPlugin: lane.onAddPlugin,
        onRemoveChainSlot: lane.onRemoveChainSlot,
        onOpenPluginEditor: lane.onOpenPluginEditor,

        // The sequencer (docs/sequencer.md).
        onToggleSeqGrid: id => toggleIn(seqOpen, id),
        onSetSequence: lane.onSetSequence,
        onToggleSequenceBypass: lane.onToggleSequenceBypass,
        onAuditionStep: lane.onAuditionStep,
        onEscapeAudition: lane.onEscapeAudition,

        // Takes (docs/takes.md §3).
        getTakePeaks: content.takePeaks.fetch,
        onSelectTake: lane.onSelectTake,
        onDeleteTake: lane.onDeleteTake,
        onSetComp: lane.onSetComp,
        onCompMode,

        // Import (docs/import.md): the + menu's chooser and the lane drop.
        onImportAudio: project.importWithDialog,
        onImportDrop: project.onImportDrop,

        onArm: record.onArm,
        onRecordKey: record.onRecordKey,
    });
    wireChrome();
    wireKeyboard();
    project.init();
    setRenderer(renderNow);
    startPolling();
}

try {
    console.log('Calling initApp()...');
    initApp();
    console.log('App Initialized. Hiding overlay.');
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
} catch (err) {
    console.error('Critical Init Error:', err);
    const status = document.getElementById('loading-status');
    if (status) status.innerHTML = `<span style="color:#ef4444">Init Failed: ${err.message}</span>`;
}

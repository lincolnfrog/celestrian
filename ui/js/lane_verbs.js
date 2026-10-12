/**
 * The lane verbs: what a lane's own controls ask the engine — delete,
 * rename, loop / one-shot, the take list and the comp, the song and its
 * step loop, input and monitoring, the rack — and undo / redo. Each is
 * ONE bridge call whose status line is read off the engine's answer
 * (shell_io.js `call`): what was done, or what was NOT done and, where
 * the shell can know it, why. A live take is the common reason: while
 * one is armed or capturing the engine refuses whatever changes what
 * sounds when. The reason is read from the graph as it is when the
 * refusal comes (shell_io.js takeLiveNow), not from the last poll.
 *
 * AN EDIT THAT WOULD CHANGE NOTHING IS NOT SENT. The engine answers
 * false for it — nothing was applied — and a "refused" line would be a
 * lie about a click that asked for what is already so. A verb that can
 * be asked for the state the lane has checks the last poll first.
 */

import { lastState, lastNodesById, lastRootId, lastFrame, anyTakeLive }
    from './session_facts.js';

/** What a payload step and a published step both say. */
const stepFacts = s => [
    String(s.name || ''), Math.round(s.len), !!s.cue,
    Math.round(s.fadeIn || 0), Math.round(s.fadeOut || 0),
    (s.next || []).map(n => [n.to, n.w === undefined ? 1 : n.w]),
];

const hasSteps = song => !!song && Array.isArray(song.steps) && song.steps.length > 0;

/** Is the song `payload` asks for the song `published` already is? No
 * song on both sides counts: a clear with nothing to clear. */
export function sameSong(payload, published) {
    if (!hasSteps(payload) || !hasSteps(published)) {
        return hasSteps(payload) === hasSteps(published);
    }
    const facts = song => JSON.stringify([
        song.steps.map(stepFacts),
        (Number(song.seed) >>> 0) || 0,
        Object.entries(song.gates || {}).map(([id, bits]) =>
            [id, song.steps.map((_, i) => !!(bits && bits[i]))]),
    ]);
    return facts(payload) === facts(published);
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * @param {object} deps
 * @param {object} deps.io  createShellIo's io
 * @param {() => void} deps.dropStaleEdits  drop the previews and
 *        verdicts an undo or redo makes stale (edit_verdict.js dropStale)
 */
export function createLaneVerbs({ io, dropStaleEdits }) {
    const { call, setLogLine, freshState, takeLiveNow } = io;
    const nodeOf = id => lastNodesById.get(id) || null;
    /** The record a song lives on: the root's is the state itself. */
    const holderOf = id => (id === lastRootId ? lastState : nodeOf(id));

    /** A failure line for a verb the live-take gate covers: `what` did
     * not happen because a take is live — else for `otherwise`. */
    const notDone = (what, otherwise = 'nothing changed') => async () =>
        `${what} — ${(await takeLiveNow()) ? 'a take is live' : otherwise}`;

    /** Undo / redo. Whatever the edit being replaced left in flight —
     * its preview, its queued verdict — goes with the keystroke. */
    function step(verb) {
        dropStaleEdits();
        const name = verb === 'undo' ? 'Undo' : 'Redo';
        const flag = verb === 'undo' ? 'canUndo' : 'canRedo';
        return call(verb, [], name, async () => {
            const state = await freshState();
            if (anyTakeLive()) return `${name} waits — a take is live`;
            if (state && state[flag] === false) return `Nothing to ${verb}`;
            return `${name} did not apply — nothing changed`;
        });
    }

    /** Undo is the safety net: no confirm on delete. */
    const onDelete = id =>
        call('deleteNode', [id], 'Deleted — ⌘Z to undo', notDone('Delete refused'));

    function onRename(id, name) {
        const node = nodeOf(id);
        if (node && node.name === name) return Promise.resolve(false);
        return call('renameNode', [id, name], `Renamed to "${name}"`,
            'Not renamed — nothing changed');
    }

    /** 'own' = loop, 'context' = one-shot. A node holding everything
     * recorded cannot rest: nothing would set the cycle it fires in. */
    function onSetPeriodSource(id, source) {
        const node = nodeOf(id);
        if (node && (node.periodSource || 'own') === source) {
            return Promise.resolve(false);
        }
        return call('setPeriodSource', [id, source], source === 'context'
            ? 'One-shot: sounds once per cycle (⌘Z to undo)'
            : 'Looping again (⌘Z to undo)',
            notDone(source === 'context' ? 'Still a loop' : 'Still a one-shot',
                source === 'context'
                    ? 'it holds all that is recorded, and something must set the cycle'
                    : 'nothing changed'));
    }

    /* Takes (docs/takes.md §3): undoable, refused mid-take. */

    function onSelectTake(id, index) {
        const node = nodeOf(id);
        if (node && node.activeTake === index) return Promise.resolve(false);
        return call('selectTake', [id, index],
            `Take ${index + 1} sounds (⌘Z to undo)`,
            notDone(`Take ${index + 1} not selected`));
    }

    function onDeleteTake(id, index) {
        return call('deleteTake', [id, index],
            `Take ${index + 1} removed (⌘Z to undo)`,
            notDone(`Take ${index + 1} not removed`,
                ((nodeOf(id) || {}).takes || 0) < 2
                    ? "a slot's last take stays (delete the track to remove it)"
                    : 'nothing changed'));
    }

    function onSetComp(id, cells) {
        const node = nodeOf(id);
        if (node && sameList(cells, node.comp || [])) return Promise.resolve(false);
        return call('setComp', [id, cells],
            cells.length ? 'Comp updated (⌘Z to undo)'
                         : 'Comp cleared — the active take throughout (⌘Z to undo)',
            notDone('Comp not changed', 'the engine refused it'));
    }

    /* The sequencer (docs/sequencer.md). A song on the ROOT carries the
     * frame's resting zero: the root anchors there, so authoring moves
     * nothing (docs/frame.md §4). */

    function onSetSequence(id, payload) {
        const holder = holderOf(id);
        if (holder && sameSong(payload, holder.sequence)) {
            return Promise.resolve(false);
        }
        const branches = hasSteps(payload) && payload.steps.some(s => (s.next || []).length);
        return call('setSequence',
            payload && id === lastRootId && lastFrame
                ? [id, payload, lastFrame.rest] : [id, payload],
            payload ? 'sequence updated (⌘Z to undo)'
                    : 'sequence cleared (⌘Z to undo)',
            notDone('Song not changed', branches && id !== lastRootId
                ? 'a song that branches lives on the top level only'
                : 'the engine refused it'));
    }

    /** The bypass is a fact of the song: without one there is none. */
    function onToggleSequenceBypass(id) {
        const holder = holderOf(id);
        if (holder && !hasSteps(holder.sequence)) {
            setLogLine('No song to bypass — add a step first');
            return Promise.resolve(false);
        }
        return call('toggleSequence', [id], 'sequence toggled (⌘Z to undo)',
            notDone('Song bypass not toggled'));
    }

    // The stack whose step is looping (Escape's target), as the engine
    // last confirmed it.
    let auditionOwner = null;

    /** The step audition: loop one step (−1 releases). Not undoable. */
    async function onAuditionStep(id, stepIndex) {
        const looping = stepIndex >= 0;
        const applied = await call('auditionStep', [id, stepIndex], looping
            ? 'looping step ' + (stepIndex + 1) + ' — R records into it · Esc stops'
            : 'loop released — the song resumes whole',
            notDone(looping ? `Step ${stepIndex + 1} is not looping`
                            : 'The step keeps looping',
                looping ? 'the song never reaches it (or is bypassed)'
                        : 'nothing changed'));
        if (applied) auditionOwner = looping ? id : null;
        return applied;
    }

    function onEscapeAudition() {
        if (auditionOwner == null) return Promise.resolve(false);
        return onAuditionStep(auditionOwner, -1);
    }

    /* Input and monitoring: wiring stays live under a take. */

    function onSetInput(id, channelIndex) {
        const node = nodeOf(id);
        if (node && node.inputChannel === channelIndex) return Promise.resolve(false);
        return call('setNodeInput', [id, channelIndex],
            `Input set to channel ${channelIndex + 1}`,
            'Input not changed — only a track has one');
    }

    /** The right input of a stereo pair; −1 is mono. */
    function onSetInputRight(id, channelIndex) {
        const node = nodeOf(id);
        if (node && node.inputChannelR === channelIndex) return Promise.resolve(false);
        return call('setNodeInputRight', [id, channelIndex], channelIndex >= 0
            ? `Stereo pair: right = channel ${channelIndex + 1}`
            : 'Track set to mono',
            'Input not changed — only a track has one');
    }

    const onMonitor = (id, on) =>
        call('setMonitor', [id, on], on
            ? 'Monitoring input through the track'
            : 'Input monitoring off',
            'Monitoring not changed — only a track has an input');

    /* The rack (docs/vst3.md). A plugin add answers once the plugin has
     * loaded and its slot is in the chain — or could not be. */

    const onSetSlotEnabled = (id, slotUuid, enabled, label) =>
        call('setSlotEnabled', [id, slotUuid, enabled],
            `${label || 'fx'} ${enabled ? 'on' : 'off'}`,
            `${label || 'fx'} not switched — it is no longer in the rack`);

    const onAddPlugin = (id, pluginUid, name) =>
        call('addPluginToChain', [id, pluginUid, -1], `${name} added (⌘Z to undo)`,
            `${name} not added — it could not be loaded (rescan in Plugins)`);

    const onRemoveChainSlot = (id, slotUuid, name) =>
        call('removeChainSlot', [id, slotUuid],
            `${name || 'plugin'} removed (⌘Z to undo)`,
            `${name || 'plugin'} not removed — nothing changed`);

    const onOpenPluginEditor = (id, slotUuid) =>
        call('openPluginEditor', [id, slotUuid], undefined,
            'No editor to open — the plugin is missing');

    /** A window's bypass chip: silent when it flips (the chip shows
     * it), a line when a take holds it. */
    const onToggleWindow = id =>
        call('toggleLoopWindow', [id], undefined, async () =>
            ((await takeLiveNow()) ? 'Loop window not toggled — a take is live' : ''));

    return {
        step, onDelete, onRename, onSetPeriodSource,
        onSelectTake, onDeleteTake, onSetComp,
        onSetSequence, onToggleSequenceBypass, onAuditionStep, onEscapeAudition,
        onSetInput, onSetInputRight, onMonitor,
        onSetSlotEnabled, onAddPlugin, onRemoveChainSlot, onOpenPluginEditor,
        onToggleWindow,
    };
}

/**
 * mock/graph_crud.js — structural graph edits (create/delete/rename/
 * reorder/move/combine), per-node flag toggles, and the per-node knobs
 * (input routing, pan, gain, period source). Everything here mutates the
 * state singleton; undo bookkeeping is the dispatch's job (mock_backend
 * callNative), with popUndoForRefusal on the refusal paths.
 */

import {
    state, generateId, findNode, findParent, removeNodeFromParent,
    committedClipCount, findSoleCommittedClip, definerStackNode,
} from './state.js';
import { popUndoForRefusal } from './undo.js';
import { quantumSamples } from './rate.js';
import { retimeSequences } from './sequence.js';

// createNode(type, parentId)
export function createNode(type, parentId = null) {
    const node = {
        id: generateId(),
        name: type === 'clip' ? 'New Clip' : 'New Stack',
        type: type,
        x: 0,
        y: 0,
        w: 200,
        h: 100,
        duration: 0,
        isRecording: false,
        isPlaying: false,
        isMuted: false,
        isSoloed: false,
        effectiveQuantum: 0,
        inputChannel: -1,
        inputChannelR: -1,
        channels: 1,
        pan: 0,
        gain: 1,
        periodSource: 'own'
    };

    if (type === 'stack') {
        node.nodes = [];
        node.isExpanded = true;
    }

    // Add to parent or top-level
    if (parentId) {
        const parent = findNode(parentId);
        if (parent && parent.type === 'stack') {
            parent.nodes = parent.nodes || [];
            parent.nodes.push(node);
        }
    } else {
        state.nodes.push(node);
    }

    console.log('[MockBackend] Created node:', node.id, type);
    return node.id;
}

export function deleteNode(id) {
    const node = findNode(id);
    // Unknown node = a refusal (F-C): drop the dispatch's snapshot.
    if (!node) { popUndoForRefusal(); return; }
    if (node.isRecording) {
        // cancel is the verb for takes — a refused delete records
        // nothing (drop the dispatch's pre-pushed undo snapshot).
        popUndoForRefusal();
        return;
    }
    removeNodeFromParent(id);
    // Q13 revert (engine parity, applyEdit Remove): deleting the last
    // committed content leaves nothing defining Q — (Q, epoch) revert to
    // unestablished. Undo restores them via the snapshot. A 2→1 delete
    // touches nothing (mutability is derived from the count).
    if (state.islandQ > 0 && committedClipCount() === 0) {
        retimeSequences(state.islandQ, 0);  // sequences track Q: cleared
        state.islandQ = 0;
        state.islandEpoch = 0;
        console.log('[MockBackend] Q13 revert: island (Q, epoch) → unestablished');
    }
    // RE-OPEN ⟹ UNCOLLAPSE (engine parity): back down to the sole take
    // with a lock-collapse behind it — restore the full material with
    // the old trim as the window, so it can be trimmed LONGER again.
    // Audio-neutral; Q/epoch untouched. Undo snapshot covers.
    if (committedClipCount() === 1) {
        const survivor = findSoleCommittedClip();
        if (survivor && survivor._precollapse) {
            const pre = survivor._precollapse;
            survivor.duration = pre.dur;
            survivor.loopStart = pre.ls;
            survivor.loopEnd = pre.le;
            survivor.origin = pre.origin;
            delete survivor._precollapse;
            console.log('[MockBackend] Q13 re-open: uncollapsed', survivor.id);
        }
    }
    // The GROUP twin: back down to a definer stack whose members were
    // group-collapsed — full takes back, the trim back on the stack.
    {
        const ds = definerStackNode();
        if (ds && ds._precollapse) {
            (ds.nodes || []).forEach(m => {
                if (m.type !== 'clip' || !m._precollapse) return;
                m.duration = m._precollapse.dur;
                m.loopStart = 0;
                m.loopEnd = m._precollapse.dur;
                delete m._precollapse;
            });
            ds.loopStart = ds._precollapse.ls;
            ds.loopEnd = ds._precollapse.le;
            delete ds._precollapse;
            console.log('[MockBackend] Q13 re-open: group uncollapsed', ds.id);
        }
    }
    console.log('[MockBackend] Deleted node:', id);
}

export function renameNode(id, newName) {
    const node = findNode(id);
    if (node) {
        node.name = newName;
        console.log('[MockBackend] Renamed node:', id, '→', newName);
    }
}

export function reorderNode(nodeId, newParentId, newIndex) {
    const node = findNode(nodeId);
    if (!node) { popUndoForRefusal(); return; }  // unknown = refusal (F-C)

    // Remove from current parent
    removeNodeFromParent(nodeId);

    // Add to new parent at specified index. The ROOT is a valid parent
    // (engine parity: Move to the island root = top level) — and an
    // unknown parent must never LOSE the node.
    const newParent = findNode(newParentId);
    if (newParent && newParent.type === 'stack') {
        newParent.nodes = newParent.nodes || [];
        const index = Math.max(0, Math.min(newIndex, newParent.nodes.length));
        newParent.nodes.splice(index, 0, node);
        console.log('[MockBackend] Reordered node:', nodeId, 'to', newParentId, 'at index', index);
    } else {
        const index = Math.max(0, Math.min(newIndex, state.nodes.length));
        state.nodes.splice(index, 0, node);
        console.log('[MockBackend] Reordered node:', nodeId, 'to TOP LEVEL at', index);
    }
}

export function setNodePosition(nodeId, x, y) {
    const node = findNode(nodeId);
    if (node) {
        node.x = x;
        node.y = y;
        console.log('[MockBackend] Set position:', nodeId, 'to', x, y);
    }
}

/**
 * Combine two nodes into a new stack.
 * Creates a new stack at the target's position, containing both nodes.
 */
export function combineNodes(draggedId, targetId) {
    const draggedNode = findNode(draggedId);
    const targetNode = findNode(targetId);

    if (!draggedNode || !targetNode) {
        console.warn('[MockBackend] combineNodes: Node not found');
        return null;
    }

    // Find parent of target to insert new stack there
    const targetParent = findParent(targetId);
    const targetList = targetParent ? targetParent.nodes : state.nodes;
    let targetIndex = targetList.findIndex(n => n.id === targetId);
    // Account for the dragged node vacating an earlier slot in the same list
    const draggedIndex = targetList.findIndex(n => n.id === draggedId);
    if (draggedIndex >= 0 && draggedIndex < targetIndex) targetIndex--;

    // Remove both nodes from their parents
    removeNodeFromParent(draggedId);
    removeNodeFromParent(targetId);

    // Create new stack
    const newStack = {
        id: `stack-${state.nextId++}`,
        name: 'Combined Stack',
        type: 'stack',
        x: targetNode.x || 0,
        y: targetNode.y || 0,
        w: Math.max(targetNode.w || 400, draggedNode.w || 400),
        h: 300,
        isExpanded: true,
        // No fabricated Q (audit 2026-08-31 F-B): the island quantum
        // is STORED state (state.islandQ) — combining empty clips used
        // to declare a bogus 1 s Q here that effectiveQuantumForState's
        // legacy scan then picked up.
        effectiveQuantum: targetNode.effectiveQuantum || 0,
        nodes: [targetNode, draggedNode]  // Target first, then dragged
    };

    // Insert at target's original position. Re-resolve the list first:
    // removeNodeFromParent REPLACES the parent's nodes array, so the
    // pre-removal targetList reference is orphaned by now.
    const insertList = targetParent ? targetParent.nodes : state.nodes;
    if (targetIndex >= 0) {
        insertList.splice(Math.min(targetIndex, insertList.length), 0, newStack);
    } else {
        insertList.push(newStack);
    }

    console.log('[MockBackend] Combined nodes into stack:', newStack.id);
    return newStack.id;
}

/**
 * Shared flag flip behind the four toggle handlers: flips `node[key]`
 * and logs with the handler's label. `stackOnly` gates toggles that
 * only make sense on a stack (expand/collapse).
 */
function toggleNodeFlag(id, key, { label, stackOnly = false }) {
    const node = findNode(id);
    if (!node || (stackOnly && node.type !== 'stack')) return;
    node[key] = !node[key];
    console.log(`[MockBackend] ${label}:`, id, '→', node[key]);
}

// (togglePlay was deleted with Q16: per-node Play/Stop is superseded —
// mute/solo + the one transport are the per-node play controls. The
// node's isPlaying survives as the content-sounds gate the engine also
// publishes; the user verb is gone.)

// Solo canon (Q16): per-node flag — island-wide, ADDITIVE (multiple
// solos sum), fractal (a soloed stack covers its subtree, resolved
// engine-side at render). Not undoable (engine parity: a monitoring
// gesture, absent from UNDOABLE like the mixer knobs).
export function toggleSolo(id) {
    toggleNodeFlag(id, 'isSoloed', { label: 'Toggle solo' });
}

export function toggleMute(id) {
    toggleNodeFlag(id, 'isMuted', { label: 'Toggle mute' });
}

export function toggleStackExpand(id) {
    toggleNodeFlag(id, 'isExpanded', { label: 'Toggle expand', stackOnly: true });
}

export function setNodeInput(id, channelIndex) {
    const node = findNode(id);
    if (node) {
        node.inputChannel = channelIndex;
        console.log('[MockBackend] Set input:', id, '→ channel', channelIndex);
    }
}

export function setNodeInputRight(id, channelIndex) {
    const node = findNode(id);
    if (node) {
        node.inputChannelR = channelIndex;
        node.channels = channelIndex >= 0 ? 2 : 1;
        console.log('[MockBackend] Set right input:', id, '→', channelIndex);
    }
}

// Mixer knob — like effect params, NOT undoable (engine parity).
export function setNodePan(id, pan) {
    const node = findNode(id);
    if (node) node.pan = Math.max(-1, Math.min(1, pan));
}

// Volume fader, clamped [0, 1] — unity ceiling, the no-boost law
// (engine parity: AudioEngine::setNodeGain).
export function setNodeGain(id, gain) {
    // The island ROOT is not in state.nodes — its gain is the MASTER
    // fader (engine parity: the root stack's output stage).
    if (id === 'mock-root') {
        state.masterGain = Math.max(0, Math.min(1, gain));
        return;
    }
    const node = findNode(id);
    if (node) node.gain = Math.max(0, Math.min(1, gain));
}

// The Q5 period-source knob — UNDOABLE (a musical fact, unlike the
// mixer knobs). CLIPS ONLY (engine parity: a stack has no origin to
// anchor a firing to); refusals pop their pre-pushed undo snapshot.
export function setPeriodSource(id, source) {
    const node = findNode(id);
    if (!node || node.type !== 'clip') {
        popUndoForRefusal();
        return;
    }
    node.periodSource = source === 'context' ? 'context' : 'own';
}

/**
 * mock/track_templates.js — the track-template library (Q17, the Q7
 * companion), engine parity for ProjectManager::{save,list,createFrom}
 * TrackTemplate + AudioEngine::{capture,insert}TrackTemplate.
 *
 * A track template is a SAVED DECISION: structure + names + input
 * assignments of a track or group, captured from the selection and
 * replayed from the creation menu. Capture is the Q7 canon minimum and
 * the shape is ADDITIVE (extra keys ride in later; absent = default) —
 * exactly the engine's on-disk format, minus the disk: the mock's
 * library is a module-level map ("the user-level TrackTemplates dir").
 *
 * createFromTrackTemplate is UNDOABLE as ONE step (the dispatch
 * snapshots before the handler — a 5-track group arrives and departs
 * the undo log whole, mirroring the engine's single Insert edit).
 * saveTrackTemplate writes the LIBRARY, not the graph: never undoable.
 */

import { state, generateId, findNode } from './state.js';
import { popUndoForRefusal } from './undo.js';

// name → { name, node } — insertion order is irrelevant; listing sorts
// by name (stable menu order beats mtime shuffle, engine parity).
const library = new Map();

/** Engine parity: track_templates::capture — structure+names+inputs. */
function capture(node) {
    if (node.type === 'stack') {
        return {
            type: 'stack',
            name: node.name,
            children: (node.nodes || []).map(capture),
        };
    }
    return {
        type: 'clip',
        name: node.name,
        inputChannel: node.inputChannel ?? -1,
        inputChannelR: node.inputChannelR ?? -1,
    };
}

/** Engine parity: track_templates::countClips. */
function countClips(tpl) {
    if (tpl.type === 'clip') return 1;
    return (tpl.children || []).reduce((n, c) => n + countClips(c), 0);
}

/** Engine parity: track_templates::build — fresh EMPTY armable copies
 * with new ids; a template stamps copies, never aliases. */
function build(tpl) {
    const base = {
        id: generateId(),
        name: tpl.name || (tpl.type === 'stack' ? 'New Stack' : 'New Clip'),
        type: tpl.type,
        x: 0, y: 0, w: 200, h: 100,
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
        periodSource: 'own',
    };
    if (tpl.type === 'stack') {
        base.nodes = (tpl.children || []).map(build);
        base.isExpanded = true;
    } else {
        base.inputChannel = tpl.inputChannel ?? -1;
        base.inputChannelR = tpl.inputChannelR ?? -1;
        base.channels = base.inputChannelR >= 0 ? 2 : 1;
    }
    return base;
}

// saveTrackTemplate(uuid, name) — library write, NOT a graph edit.
export function saveTrackTemplate(uuid, name) {
    const trimmed = (name || '').trim();
    const node = findNode(uuid);
    if (!trimmed || !node) return false;
    library.set(trimmed, { name: trimmed, node: capture(node) });
    console.log('[MockBackend] Saved track template:', trimmed);
    return true;
}

// listTrackTemplates() → [{name, kind, tracks}], name-sorted.
export function listTrackTemplates() {
    return [...library.values()]
        .map(t => ({
            name: t.name,
            kind: t.node.type === 'stack' ? 'group' : 'clip',
            tracks: countClips(t.node),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// createFromTrackTemplate(name, parentId?) — ONE undoable insert.
export function createFromTrackTemplate(name, parentId = '') {
    const t = library.get((name || '').trim());
    if (!t) {
        popUndoForRefusal();  // refused edits record nothing
        return false;
    }
    const built = build(t.node);
    if (parentId) {
        const parent = findNode(parentId);
        if (!parent || parent.type !== 'stack') {
            popUndoForRefusal();
            return false;
        }
        parent.nodes = parent.nodes || [];
        parent.nodes.push(built);
    } else {
        state.nodes.push(built);
    }
    console.log('[MockBackend] Created from track template:', name,
        '→', built.id);
    return true;
}

/** TEST-ONLY: wipe the library (scenario isolation). */
export function clearTrackTemplates() {
    library.clear();
}

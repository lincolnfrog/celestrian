/**
 * mock/track_templates.js — the track-template library (engine
 * ProjectManager::{save,list,createFrom}TrackTemplate and
 * track_templates::capture / build). A template is structure, names and
 * input setup, captured from a node and stamped as fresh empty copies;
 * the library is a module-level map. Saving writes the library, not the
 * graph; an insert is one undo step.
 */

import { state, findNode, nodeOrRoot } from './state.js';
import { newNode } from './graph_crud.js';

const library = new Map();  // name → { name, node }

function capture(node) {
    if (node.type === 'stack') {
        return { type: 'stack', name: node.name, children: (node.nodes || []).map(capture) };
    }
    return {
        type: 'clip',
        name: node.name,
        inputChannel: node.inputChannel ?? -1,
        inputChannelR: node.inputChannelR ?? -1,
        ...(node.monitor ? { monitor: true } : {}),
    };
}

const countClips = tpl => (tpl.type === 'clip' ? 1
    : (tpl.children || []).reduce((n, c) => n + countClips(c), 0));

function build(tpl) {
    if (tpl.type === 'stack') {
        return newNode('stack', { name: tpl.name || 'New Stack',
                                  nodes: (tpl.children || []).map(build) });
    }
    const right = tpl.inputChannelR ?? -1;
    return newNode('clip', {
        name: tpl.name || 'New Clip',
        inputChannel: tpl.inputChannel ?? -1,
        inputChannelR: right,
        channels: right >= 0 ? 2 : 1,
        monitor: !!tpl.monitor,
    });
}

export function saveTrackTemplate(uuid, name) {
    const trimmed = (name || '').trim();
    const node = findNode(uuid);
    if (!trimmed || !node) return false;
    library.set(trimmed, { name: trimmed, node: capture(node) });
    return true;
}

/** [{ name, kind, tracks }], sorted by name. */
export function listTrackTemplates() {
    return [...library.values()]
        .map(t => ({ name: t.name, kind: t.node.type === 'stack' ? 'group' : 'clip',
                     tracks: countClips(t.node) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** No parent id reads as the root. */
export function createFromTrackTemplate(name, parentId = '') {
    const template = library.get((name || '').trim());
    const parent = parentId ? nodeOrRoot(parentId) : state.root;
    if (!template || !parent || parent.type !== 'stack') return false;
    parent.nodes.push(build(template.node));
    return true;
}

/** Test hook: empty the library. */
export function clearTrackTemplates() {
    library.clear();
}

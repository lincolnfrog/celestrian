/**
 * The structure verbs: create-and-select, drag-to-group, group the
 * selection, move to the top level, ungroup. Each is a sequence of
 * bridge calls on the graph as the last poll showed it, with one status
 * line (shell_io.js callEach). Structure is locked under a live take:
 * the engine refuses the move, the sequence stops there, and the line
 * says what did not happen.
 */

import { findNodeInTree } from './view_model.js';
import { NO_ANSWER } from './shell_io.js';
import { lastNodesById, lastRootId, indexNodes, parentOf, topLevelNodes,
         firstNewNodeId } from './session_facts.js';

/** The status line when combineNodes answers no group: the engine
 * refused. */
export const groupRefusal = takeLive => takeLive
    ? 'Grouping refused — a take is live'
    : 'Grouping refused — nothing changed';

/** `what` was refused before anything changed: because a take is live,
 * or for a reason the shell cannot see. */
const refusedWhole = (what, takeLive) =>
    `${what} refused — ${takeLive ? 'a take is live' : 'nothing changed'}`;

/** The status line when a move of a sequence was refused after `moved`
 * of its `total` moves had applied. */
export function moveRefusal(takeLive, moved, total) {
    if (moved === 0) return refusedWhole('Move', takeLive);
    return `Moved ${moved} of ${total}, then refused — ` +
        `${takeLive ? 'a take is live' : 'the rest stay'} (⌘Z steps back)`;
}

/** The status line when an ungroup was refused after `moved` of the
 * group's `total` tracks had moved up. The group is never deleted over
 * tracks that did not all move. */
export function ungroupRefusal(takeLive, moved, total) {
    if (moved === 0) return refusedWhole('Ungroup', takeLive);
    return `Ungroup stopped after ${moved} of ${total} tracks — ` +
        `${takeLive ? 'a take is live' : 'the engine refused the next step'}; ` +
        'the group stays (⌘Z steps back)';
}

/**
 * One reorderNode step per id, appended to `parentId` from `index` —
 * LEAVING OUT a move that would put a node where it is: the engine
 * answers false for it (nothing applied), and that is not a refusal.
 * `siblings` are the parent's child ids now, in order; each kept step
 * is applied to a copy of them so the next is judged on what it leaves.
 */
export function appendSteps(ids, parentId, index, siblings = []) {
    let order = siblings.slice();
    const steps = [];
    ids.forEach((id, i) => {
        const next = order.filter(other => other !== id);
        next.splice(Math.max(0, Math.min(index + i, next.length)), 0, id);
        const stays = next.length === order.length &&
            next.every((other, k) => other === order[k]);
        if (stays) return;
        steps.push(['reorderNode', id, parentId, index + i]);
        order = next;
    });
    return steps;
}

const idsOf = nodes => (nodes || []).map(n => n.id);

/**
 * @param {object} deps
 * @param {object} deps.io  createShellIo's io
 * @param {(id: ?string) => void} deps.selectWhenPresent  select a lane
 *        once a patch lists it
 */
export function createStructureVerbs({ io, selectWhenPresent }) {
    const { setLogLine, call, callEach, readState, takeLiveNow } = io;

    /**
     * Run a creation verb and SELECT what it made — the track you are
     * about to arm, play or name. The new node is found by diffing the
     * tree around the call (a template or an import answers no id); a
     * lost read on either side selects nothing. Returns the verb's
     * answer.
     */
    async function createAndSelect(create) {
        const before = await readState();
        const result = await create();
        const after = await readState();
        if (before && after) {
            selectWhenPresent(firstNewNodeId(after.nodes, indexNodes(before.nodes)));
        }
        return result;
    }

    /** A new empty track under group `parentId` (the top level when
     * ''), selected: createNode answers the id of what it made. */
    async function createTrack(parentId = '') {
        const id = await call('createNode', ['clip', parentId], undefined,
            'No track added — the group is no longer there');
        if (id) selectWhenPresent(id);
        return id;
    }

    /** Wrap `dragged` and `target` in a new group, which lands in the
     * target's slot. Answers its id; nothing, having said why, when the
     * engine refuses. */
    const combine = (dragged, target) =>
        call('combineNodes', [dragged, target], undefined,
            async () => groupRefusal(await takeLiveNow()));

    /** The line for a sequence of `total` moves the engine ended by
     * refusing one, `moved` of them applied. */
    const movesRefused = total => async (answer, moved) =>
        moveRefusal(await takeLiveNow(), moved, total);

    /**
     * Drag-to-group: dropped on a clip, the first id combines with it
     * into a new group; dropped on a group, every id moves inside. The
     * rest are appended in drag order, after the children the group
     * holds once it exists (one read). Ids no longer in the graph are
     * left out.
     */
    async function onDropLane(ids, target) {
        const tNode = lastNodesById.get(target.id);
        const moving = ids.filter(id => lastNodesById.has(id));
        if (!tNode || !moving.length) return;
        const onGroup = tNode.type === 'stack';
        const stackId = onGroup ? target.id : await combine(moving[0], target.id);
        if (!stackId) return;
        const rest = onGroup ? moving : moving.slice(1);
        let inside = [];
        if (rest.length) {
            const st = await readState();
            if (!st) { setLogLine(NO_ANSWER); return; }
            inside = idsOf((findNodeInTree(st.nodes, stackId) || {}).nodes);
        }
        const tName = tNode.name || 'group';
        const steps = appendSteps(rest, stackId, inside.length, inside);
        // A new group is news even when nothing else had to move.
        if (!steps.length && onGroup) return;
        await callEach(steps, moving.length > 1
            ? `Grouped ${moving.length} tracks with "${tName}"`
            : onGroup
                ? `Moved into "${tName}"`
                : `Grouped with "${tName}" — rename the group on its rail`,
            movesRefused(steps.length));
    }

    /** Group the selection in place: the first-selected is combine's
     * target, and the new group holds two children, so ids[i] appends
     * at index i. */
    async function onGroupSelection(ids) {
        if (ids.length < 2) return;
        const stackId = await combine(ids[1], ids[0]);
        if (!stackId) return;
        const steps = appendSteps(ids.slice(2), stackId, 2, [ids[0], ids[1]]);
        await callEach(steps,
            `Grouped ${ids.length} tracks — rename the group on its rail`,
            movesRefused(steps.length));
    }

    /** Drag-out: append to the top level (the island root). A lane
     * already last there has nowhere to go: nothing is asked or said. */
    async function onMoveToTop(ids) {
        if (!lastRootId) return;
        const st = await readState();
        if (!st) { setLogLine(NO_ANSWER); return; }
        const top = idsOf(st.nodes);
        const steps = appendSteps(ids, lastRootId, top.length, top);
        if (!steps.length) return;
        await callEach(steps,
            ids.length > 1 ? `Moved ${ids.length} tracks to the top level`
                           : 'Moved to the top level',
            movesRefused(steps.length));
    }

    /** Ungroup: the children move into the group's parent from the
     * group's own slot, THEN the empty shell is deleted — deleting
     * first would orphan the children, and a shell whose children did
     * not all move is never deleted: the first refusal ends it. */
    async function onUngroup(groupId) {
        const group = lastNodesById.get(groupId);
        if (!group) return;
        const parent = parentOf(group);
        const siblings = parent ? (parent.nodes || []) : topLevelNodes();
        const members = idsOf(group.nodes);
        const steps = appendSteps(members, parent ? parent.id : lastRootId,
            Math.max(0, siblings.indexOf(group)), idsOf(siblings));
        await callEach([...steps, ['deleteNode', groupId]],
            `Ungrouped "${group.name}" — tracks moved up (⌘Z steps back through it)`,
            async (answer, moved) =>
                ungroupRefusal(await takeLiveNow(), moved, members.length));
    }

    return { createTrack, createAndSelect, onDropLane, onGroupSelection,
             onMoveToTop, onUngroup };
}

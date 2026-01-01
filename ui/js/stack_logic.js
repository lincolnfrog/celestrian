/**
 * Logic for grouping nodes into vertical stacks for the '+' button placement.
 * Encapsulates the logic to enable unit testing.
 */

export function groupNodesByVisualX(nodes) {
    const groups = []; // Array of node arrays

    // Stability Sort: Ensure anchor selection is identical across polls
    const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));

    sortedNodes.forEach(node => {
        let found = false;
        // visualX is injected during render loop. Fallback to raw x.
        const nx = (typeof node._visualX !== 'undefined') ? node._visualX : node.x;

        for (const group of groups) {
            const anchor = group[0];
            const ax = (typeof anchor._visualX !== 'undefined') ? anchor._visualX : anchor.x;

            // Allow 50px tolerance for alignment (loose columns)
            if (Math.abs(nx - ax) < 50) {
                group.push(node);
                found = true;
                break;
            }
        }
        if (!found) groups.push([node]);
    });

    return groups;
}

export function calculateButtonPosition(group) {
    const anchor = group[0];
    const stackX = Math.round((typeof anchor._visualX !== 'undefined') ? anchor._visualX : anchor.x);
    // Find the bottom-most edge of any clip in the group
    const maxY = Math.round(Math.max(...group.map(n => n.y + n.h)));

    // Generate stable ID from anchor UUID
    const btnId = `stack-btn-${anchor.id.slice(0, 8)}`;

    return {
        id: btnId,
        x: stackX,
        y: maxY,
        anchor: anchor
    };
}

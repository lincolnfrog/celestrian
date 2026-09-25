/**
 * The shared ruler above the lanes: the island's Q lines (the view
 * model's ticks) with sparse labels (Tape Room), and the root's looping
 * step. The ticks and labels are PLACED on every patch, in reused
 * elements: while the frame settles its zero glides between grid lines,
 * and the ruler scrolls with the lanes — each line at (line − zero) / Q,
 * named where it lands (view_model buildRulerTicks). At rest a patch
 * writes nothing (setStyle/setText skip equal values). The root
 * window's brackets rebuild only when their reconcile key changes.
 */

import { ctx } from './context.js';
import { el, pct, fmtQ, setStyle, setText } from './sv_util.js';

let rulerKey = '';

/** Patch the ruler: the root window when the frame changed, then the
 * ticks and labels from the view model. ↺ marks the SETTLED cycle; a
 * growing frame ends provisionally (…). */
export function patchRuler(vm) {
    const ruler = ctx.els.ruler;
    const rw = vm.rootWindow;
    const key = vm.cycleQ + ':' +
        (rw ? rw.startQ + '-' + rw.endQ + '-' + rw.step : '');
    if (key !== rulerKey || !ruler._marks) {
        rulerKey = key;
        ruler.textContent = '';
        ruler._marks = { ticks: [], labels: [] };
        // THE ROOT'S LOOPING STEP (docs/sequencer.md §11.2): the root has
        // no lane, so its derived window's brackets live on the ruler.
        if (rw) {
            const span = el('div', 'ruler-root-window');
            span.style.left = pct(rw.startQ, vm.cycleQ);
            span.style.width = pct(rw.endQ - rw.startQ, vm.cycleQ);
            span.title = 'Looping step ' + (rw.step + 1) + ' · ' +
                fmtQ(rw.startQ) + 'Q–' + fmtQ(rw.endQ) + 'Q (Esc stops)';
            span.appendChild(el('span', 'ruler-root-window-label mono',
                { textContent: '⟲ ' + fmtQ(rw.startQ) + 'Q–' + fmtQ(rw.endQ) + 'Q' }));
            ruler.appendChild(span);
        }
    }
    placeMarks(ruler, vm);
}

/** Each tick, and the sparse labels: majors only, plus the frame end —
 * each read where its line LANDS (`at`, `end`), so mid-glide a number
 * rides its line. The landing frame's wrap line wears the cycle-end
 * label (the frame's length, ↺ or …) wherever it is but the left edge. */
function placeMarks(ruler, vm) {
    const m = ruler._marks;
    const ticks = vm.ruler.ticks;
    const labelled = [];
    ticks.forEach((t, i) => {
        const tick = reuse(ruler, m.ticks, i, 'tick');
        setStyle(tick, 'left', pct(t.q, vm.cycleQ));
        tick.classList.toggle('major', !!t.major);
        if (t.at > 0 && (t.major || t.end)) labelled.push(t);
    });
    for (const d of m.ticks.splice(ticks.length)) d.remove();
    labelled.forEach((t, i) => {
        const lb = reuse(ruler, m.labels, i, 'tick-label');
        setStyle(lb, 'left', pct(t.q, vm.cycleQ));
        lb.classList.toggle('cycle-end', !!t.end);
        setText(lb, t.end
            ? fmtQ(vm.cycleQ) + 'Q' + (vm.frameExtended ? '…' : ' ↺')
            : fmtQ(t.at) + 'Q');
    });
    for (const d of m.labels.splice(labelled.length)) d.remove();
}

/** The pool's i-th element, made (and appended to `ruler`) when missing
 * or no longer attached. */
function reuse(ruler, pool, i, cls) {
    let d = pool[i];
    if (!d || d.parentNode !== ruler) {
        d = el('div', cls);
        ruler.appendChild(d);
        pool[i] = d;
    }
    return d;
}

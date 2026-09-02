/**
 * The shared ruler above the lanes: sparse tick labels (Tape Room),
 * rebuilt only when its reconcile key changes. The key is a content
 * signature of the tick set (tickSetSig) — a re-bucketed tick set at
 * equal count/cycle can never render stale.
 */

import { ctx } from './context.js';
import { el, pct, fmtQ, approxQ, tickSetSig } from './sv_util.js';

let rulerKey = '';

/** Rebuild the ruler's ticks + labels when the frame changed. ↺ marks
 * the SETTLED cycle; a growing frame ends provisionally (…). */
export function patchRuler(vm) {
    const rw = vm.rootWindow;
    const key = vm.cycleQ + ':' + vm.frameExtended + ':' +
        tickSetSig(vm.ruler.ticks) + ':' +
        (rw ? rw.startQ + '-' + rw.endQ + '-' + rw.step : '');
    if (key === rulerKey) return;
    rulerKey = key;
    ctx.els.ruler.textContent = '';
    // THE ROOT'S LOOPING STEP (docs/sequencer.md §11.2): the root has no
    // lane, so its derived window's brackets live on the ruler.
    if (rw) {
        const span = el('div', 'ruler-root-window');
        span.style.left = pct(rw.startQ, vm.cycleQ);
        span.style.width = pct(rw.endQ - rw.startQ, vm.cycleQ);
        span.title = 'Looping step ' + (rw.step + 1) + ' · ' +
            fmtQ(rw.startQ) + 'Q–' + fmtQ(rw.endQ) + 'Q (Esc stops)';
        span.appendChild(el('span', 'ruler-root-window-label mono',
            { textContent: '⟲ ' + fmtQ(rw.startQ) + 'Q–' + fmtQ(rw.endQ) + 'Q' }));
        ctx.els.ruler.appendChild(span);
    }
    vm.ruler.ticks.forEach(t => {
        const tick = el('div', 'tick' + (t.major ? ' major' : ''));
        tick.style.left = pct(t.q, vm.cycleQ);
        ctx.els.ruler.appendChild(tick);
        // Sparse labels (Tape Room): majors only, plus the frame end.
        // ↺ marks the SETTLED cycle; a growing frame ends provisionally
        // (…). Cycle-end detection is epsilon-tolerant (approxQ): a
        // fractionally-derived final tick must not lose its label to fp
        // noise — the same discipline as fmtQ.
        const atEnd = approxQ(t.q, vm.cycleQ);
        if (t.q > 0 && (t.major || atEnd)) {
            const lb = el('div', 'tick-label' + (atEnd ? ' cycle-end' : ''));
            lb.style.left = pct(t.q, vm.cycleQ);
            lb.textContent = atEnd
                ? fmtQ(vm.cycleQ) + 'Q' + (vm.frameExtended ? '…' : ' ↺')
                : fmtQ(t.q) + 'Q';
            ctx.els.ruler.appendChild(lb);
        }
    });
}

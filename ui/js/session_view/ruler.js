/**
 * The shared ruler above the lanes: sparse tick labels (Tape Room),
 * rebuilt only when its reconcile key changes. The key is a content
 * signature of the tick set (tickSetSig) — a re-bucketed tick set at
 * equal count/cycle can never render stale (audit 2026-08-11; the old
 * count-based key was a documented smell).
 */

import { ctx } from './context.js';
import { el, pct, fmtQ, approxQ, tickSetSig } from './sv_util.js';

let rulerKey = '';

/** Rebuild the ruler's ticks + labels when the frame changed. ↺ marks
 * the SETTLED cycle; a growing frame ends provisionally (…). */
export function patchRuler(vm) {
    const key = vm.cycleQ + ':' + vm.frameExtended + ':' +
        tickSetSig(vm.ruler.ticks);
    if (key === rulerKey) return;
    rulerKey = key;
    ctx.els.ruler.textContent = '';
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

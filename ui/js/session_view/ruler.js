/**
 * The shared ruler above the lanes: sparse tick labels (Tape Room),
 * rebuilt only when its cheap key changes. (The key's weakness — tick
 * positions changing at equal count/cycle would render stale — is a
 * documented smell, kept as-is.)
 */

import { ctx } from './context.js';
import { el, pct, fmtQ } from './sv_util.js';

let rulerKey = '';

/** Rebuild the ruler's ticks + labels when the frame changed. ↺ marks
 * the SETTLED cycle; a growing frame ends provisionally (…). */
export function patchRuler(vm) {
    const key = vm.cycleQ + ':' + vm.ruler.ticks.length + ':' + vm.frameExtended;
    if (key === rulerKey) return;
    rulerKey = key;
    ctx.els.ruler.textContent = '';
    vm.ruler.ticks.forEach(t => {
        const tick = el('div', 'tick' + (t.major ? ' major' : ''));
        tick.style.left = pct(t.q, vm.cycleQ);
        ctx.els.ruler.appendChild(tick);
        // Sparse labels (Tape Room): majors only, plus the frame end.
        // ↺ marks the SETTLED cycle; a growing frame ends provisionally (…)
        if (t.q > 0 && (t.major || t.q === vm.cycleQ)) {
            const lb = el('div',
                'tick-label' + (t.q === vm.cycleQ ? ' cycle-end' : ''));
            lb.style.left = pct(t.q, vm.cycleQ);
            lb.textContent = t.q === vm.cycleQ
                ? fmtQ(vm.cycleQ) + 'Q' + (vm.frameExtended ? '…' : ' ↺')
                : fmtQ(t.q) + 'Q';
            ctx.els.ruler.appendChild(lb);
        }
    });
}

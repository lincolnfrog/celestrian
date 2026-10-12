/**
 * THE ONE PLAYHEAD (I8): a single line from the ruler through the last
 * audio lane — never through the add-track affordance below it. Three
 * drawing modes:
 *
 *   STOPPED    drawn where the transport rests (or was just sought to),
 *              dimmed: a seek needs somewhere to land visibly, and the
 *              line says where playback resumes. It snaps — a glide
 *              would sweep a teleport.
 *   PLAYING    the animator draws it at 60fps and wraps it at the
 *              audible cycle; a poll only corrects it (animator.js).
 *   RECORDING  drawn per poll and glided by the stylesheet, in lockstep
 *              with the recording bar's edge; a jump backwards (the
 *              commit) snaps.
 *
 * Before Q there is no frame: the line shows only while playing.
 */

import { ctx } from './context.js';
import { snapThenAnimate } from './sv_util.js';
import { animatorPoll, animatorFrame, stopAnimator } from './animator.js';
import { maskPlayheadOverInspectors } from './playhead_mask.js';

/* A recording playhead moving backwards by more than this many px is a
 * commit jump — snap, never sweep backwards. */
const REC_SNAP_BACK_PX = 40;

/** Patch the playhead for this view model. `aux.rerender` marks a
 * re-render between polls (patch.js): the animator takes the frame's
 * own move from it, never its stale clock. */
export function patchPlayhead(vm, aux, anyRecording) {
    const ph = ctx.els.playhead;
    const shown = vm.lanes.length > 0 &&
        (vm.isPlaying || (vm.qEstablished && !anyRecording));
    if (!shown) {
        stopAnimator();
        ph.style.display = 'none';
        return;
    }
    ph.style.display = 'block';
    ph.classList.toggle('idle', !vm.isPlaying);
    if (vm.isPlaying && !anyRecording && vm.qEstablished) {
        if (ph.style.transition !== 'none') ph.style.transition = 'none';
        // The frame's own move first, on every patch — a re-render
        // between polls carries nothing else.
        animatorFrame(vm);
        if (!aux.rerender) animatorPoll(vm, aux);
    } else {
        stopAnimator();
        const left = (vm.playheadQ / vm.cycleQ) * ctx.els.ruler.clientWidth;
        if (!vm.isPlaying) {
            if (ph.style.transition !== 'none') ph.style.transition = 'none';
        } else {
            if (ph.style.transition === 'none') ph.style.transition = '';
            if (left < (ph._left ?? left) - REC_SNAP_BACK_PX) snapThenAnimate(ph);
        }
        ph._left = left;
        ph.style.left = left + 'px';
    }
    const audioRows = [...ctx.els.lanes.children].filter(r =>
        !r.classList.contains('lane-add') && !r.classList.contains('lane-fx') &&
        !r.classList.contains('lane-seq'));
    const last = audioRows[audioRows.length - 1];
    if (last) {
        const h = (last.offsetTop + last.offsetHeight) + 'px';
        if (ph.style.height !== h) ph.style.height = h;
    }
    // The line never crosses a row on another time axis (playhead_mask).
    maskPlayheadOverInspectors();
}

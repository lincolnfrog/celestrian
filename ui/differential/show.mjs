/**
 * One line per backend state, for `run.mjs --show`: what a journey's
 * step left behind, compact enough to read a whole journey at a glance.
 * (For reading journeys; the comparison itself is normalize.mjs.)
 */

/** `summarise(state, labelOf, q)` → e.g.
 * `Q=1Q pos=2.3Q cur=0.3Q def=@A | @A c 4Q o=0 w[1Q,3Q) | @B c 1Q o=4Q REC` */
export function summarise(state, labelOf, q) {
    const inQ = n => (q > 0 ? `${+(n / q).toFixed(3)}Q` : String(n));
    const zero = state.islandZero || 0;
    const node = (n, depth) => {
        const bits = [`${'·'.repeat(depth)}${labelOf(n.id) || '?'} ${n.type === 'stack' ? 's' : 'c'}`];
        if (n.type !== 'stack') bits.push(inQ(n.duration || 0));
        if ((n.type !== 'stack' && n.duration > 0) || n.anchored) bits.push(`o=${inQ((n.origin || 0) - zero)}`);
        if (Array.isArray(n.segments) && n.segments.length) bits.push(`cells[${n.segments.map(inQ).join(',')}]`);
        else if ((n.loopEnd || 0) > (n.loopStart || 0)) bits.push(`w[${inQ(n.loopStart)},${inQ(n.loopEnd)})`);
        if (n.loopBypassed) bits.push('bypassed');
        if (n.windowActive) bits.push('on');
        if (n.loopTop) bits.push(`top=${inQ(n.loopTop)}`);
        if (n.retime) bits.push(`retime=${inQ(n.retime)}`);
        if (n.periodSource === 'context') bits.push('one-shot');
        if (n.isPendingStart) bits.push('ARMED');
        if (n.isRecording) bits.push('REC');
        if (n.isAwaitingStop) bits.push('STOPPING');
        if (n.type !== 'stack' && (n.takes || 0) > 1) bits.push(`takes=${n.takes}/${n.activeTake}`);
        if (Array.isArray(n.comp) && n.comp.length) bits.push(`comp[${n.comp.join('')}]`);
        if (n.isMuted) bits.push('muted');
        if (n.sequence) bits.push(`song[${(n.sequence.steps || []).map(s => inQ(s.len) + (s.cue ? '!' : '')).join(' ')}]` +
            (n.sequence.bypassed ? ' off' : '') + (n.sequence.auditionStep >= 0 ? ` aud=${n.sequence.auditionStep}` : ''));
        const own = bits.join(' ');
        return [own, ...(n.nodes || []).map(c => node(c, depth + 1))].join(' | ');
    };
    const head = [
        `Q=${inQ(state.quantum || 0)}`,
        `pos=${inQ(state.islandPos || 0)}`,
        `cur=${inQ(state.masterPos || 0)}`,
        state.isPlaying ? 'playing' : 'STOPPED',
        `def=${state.definerId ? labelOf(state.definerId) || '?' : '-'}`,
        `undo=${state.canUndo ? 'y' : 'n'}/${state.canRedo ? 'y' : 'n'}`,
    ];
    if (state.sequence) head.push(`song[${(state.sequence.steps || []).map(s => inQ(s.len) + (s.cue ? '!' : '')).join(' ')}]` +
        (state.sequence.bypassed ? ' off' : '') + (state.sequence.auditionStep >= 0 ? ` aud=${state.sequence.auditionStep}` : ''));
    if (state.anchored) head.push(`root o=${inQ((state.origin || 0) - zero)}`);
    return [head.join(' '), ...(state.nodes || []).map(n => node(n, 0))].join(' | ');
}

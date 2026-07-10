/**
 * Waveform renderer — Tape Room (docs/ui_overhaul.md §3).
 *
 * Draws a filled, vertically symmetric envelope (not per-peak bars):
 * peaks are MAX-POOLED into one value per device pixel column, so the
 * same content renders identically at any tile width (per-bar drawing
 * aliased — ghost tiles of the same take looked like different audio).
 * DPR-aware: the backing store is devicePixelRatio× the CSS size, so
 * waveforms are crisp on retina displays.
 *
 * drawWaveform(canvas, peaks, opts?)
 *   opts.cssWidth / opts.cssHeight — CSS pixel size (defaults to the
 *     canvas's current layout size)
 *   opts.isComposite — deeper tape tone for group composites
 * (Legacy positional call drawWaveform(canvas, peaks, step, isComposite)
 * is still accepted; `step` is ignored.)
 */

const TAPE = { top: '#f0b45a', mid: '#e8a13c', bottom: '#c9871f' };
const COMPOSITE = { top: '#d98a52', mid: '#c96f3a', bottom: '#a85526' };

/**
 * One envelope value per CSS pixel column, max-pooled over the peaks
 * that column covers (or interpolated when upsampling). Two mappings:
 *
 * FIT (pxPerPeak omitted): column x covers peaks [x/W·n, (x+1)/W·n) —
 * right for COMMITTED clips, whose peaks are drawn once at rest.
 *
 * FIXED SCALE (pxPerPeak = p): column x covers peaks [x/p, (x+1)/p) — a
 * function of p ONLY, never of the peak count. Required for LIVE bars:
 * under fit mapping, W = round(n·p) makes W/n wobble as n grows, so
 * every drawn column shifted sub-pixel on every poll — the recording
 * waveform's left/right jitter (field 2026-07-10, twice: the wobble is
 * worst when p shrinks after a frame extension). With fixed scale, a
 * peak's pixels are immutable for the life of the take: new content
 * appends, old content never remaps.
 *
 * Exported for the append-stability unit test.
 */
export function poolColumns(peaks, cssW, pxPerPeak) {
    const n = peaks.length;
    const cols = new Float32Array(cssW);
    const fixed = pxPerPeak > 0;
    for (let x = 0; x < cssW; x++) {
        const lo = fixed ? x / pxPerPeak : (x / cssW) * n;
        const hi = fixed ? (x + 1) / pxPerPeak : ((x + 1) / cssW) * n;
        let v = 0;
        if (lo >= n) {
            cols[x] = 0; // fixed-scale trailing edge (canvas ≥ content)
            continue;
        }
        if (hi - lo >= 1) {
            for (let i = Math.floor(lo); i < Math.min(n, Math.ceil(hi)); i++) {
                const p = Math.abs(parseFloat(peaks[i]) || 0);
                if (p > v) v = p;
            }
        } else if (fixed) {
            // Fixed scale upsampling: NEAREST only. Interpolating toward
            // the next peak changes the edge column when that peak later
            // arrives — the last visible sliver of the live bar wiggled.
            v = Math.abs(parseFloat(peaks[Math.min(n - 1, Math.floor(lo))]) || 0);
        } else {
            // Fit upsampling (committed, at rest): linear interpolation
            const i = Math.min(n - 1, Math.floor(lo));
            const j = Math.min(n - 1, i + 1);
            const t = lo - i;
            const a = Math.abs(parseFloat(peaks[i]) || 0);
            const b = Math.abs(parseFloat(peaks[j]) || 0);
            v = a + (b - a) * t;
        }
        cols[x] = Math.min(1, v);
    }
    return cols;
}

export function drawWaveform(canvas, peaks, arg3 = null, arg4 = false) {
    if (!canvas) return;
    const opts = (arg3 && typeof arg3 === 'object') ? arg3 : { isComposite: !!arg4 };

    const cssW = Math.max(2, Math.floor(
        opts.cssWidth || canvas.clientWidth || canvas.width || 200));
    const cssH = Math.max(2, Math.floor(
        opts.cssHeight || canvas.clientHeight || canvas.height || 60));
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const tone = opts.isComposite ? COMPOSITE : TAPE;
    const midY = cssH / 2;

    if (!peaks || peaks.length === 0) {
        ctx.fillStyle = tone.mid;
        ctx.globalAlpha = 0.25;
        ctx.fillRect(0, midY - 0.5, cssW, 1);
        ctx.globalAlpha = 1;
        return;
    }

    const cols = poolColumns(peaks, cssW, opts.pxPerPeak);

    // DISPLAY NORMALIZATION: waveforms show SHAPE, meters show level —
    // real takes at sane input gain drew as invisible hairlines when
    // amplitude mapped linearly (field screenshot 2026-07-10). Scale the
    // clip to its own peak (boost capped at 8× so silence stays flat)
    // with a gentle perceptual exponent to lift quiet detail.
    // LIVE bars pass fixedBoost (a smoothed ratchet, live_peaks.liveBoost)
    // — re-normalizing against a running max inside each draw rescaled
    // the whole waveform whenever a louder peak arrived (the recording
    // "pump"), and drawing un-normalized popped at commit instead.
    let boost = 1;
    if (typeof opts.fixedBoost === 'number') {
        boost = opts.fixedBoost;
    } else if (opts.normalize !== false) {
        let maxV = 0;
        for (let x = 0; x < cssW; x++) if (cols[x] > maxV) maxV = cols[x];
        boost = maxV > 0 ? Math.min(0.95 / maxV, 8) : 1;
    }
    for (let x = 0; x < cssW; x++) {
        cols[x] = Math.pow(Math.min(1, cols[x] * boost), 0.65);
    }

    // Filled symmetric envelope. A 1px floor keeps silent-but-present
    // audio visible as a hairline spine.
    const amp = cssH * 0.46;
    const floor = 0.75;
    const grad = ctx.createLinearGradient(0, midY - amp, 0, midY + amp);
    grad.addColorStop(0, tone.top);
    grad.addColorStop(0.5, tone.mid);
    grad.addColorStop(1, tone.bottom);
    ctx.fillStyle = grad;

    ctx.beginPath();
    ctx.moveTo(0, midY - Math.max(floor, cols[0] * amp));
    for (let x = 1; x < cssW; x++) {
        ctx.lineTo(x, midY - Math.max(floor, cols[x] * amp));
    }
    for (let x = cssW - 1; x >= 0; x--) {
        ctx.lineTo(x, midY + Math.max(floor, cols[x] * amp));
    }
    ctx.closePath();
    ctx.fill();
}

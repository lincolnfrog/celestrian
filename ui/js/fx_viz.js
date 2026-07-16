/**
 * Effect card visualizations (docs/ui_overhaul.md effects bar).
 *
 * Geometry is PURE and unit-tested (fx_viz.test.mjs); the draw
 * functions are thin canvas painters called from the 20 Hz patch tick.
 * The EQ response curve uses the SAME RBJ cookbook math as the engine
 * (src/dsp/effects.cc) so what you see is what the biquads do.
 *
 * Live data comes from the engine's published `effects.scope`
 * (spectrum, pre-rack peak, compressor GR) — see EffectRack::getMetadata.
 */

/* ---------- RBJ biquad magnitude (mirrors src/dsp/effects.cc) ---------- */

function lowShelf(sr, f0, gainDb) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * f0 / sr;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const S = 0.9;
    const alpha = sw / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const sq = 2 * Math.sqrt(A) * alpha;
    const a0 = (A + 1) + (A - 1) * cw + sq;
    return {
        b0: A * ((A + 1) - (A - 1) * cw + sq) / a0,
        b1: 2 * A * ((A - 1) - (A + 1) * cw) / a0,
        b2: A * ((A + 1) - (A - 1) * cw - sq) / a0,
        a1: -2 * ((A - 1) + (A + 1) * cw) / a0,
        a2: ((A + 1) + (A - 1) * cw - sq) / a0,
    };
}

function peaking(sr, f0, q, gainDb) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * f0 / sr;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha / A;
    return {
        b0: (1 + alpha * A) / a0,
        b1: -2 * cw / a0,
        b2: (1 - alpha * A) / a0,
        a1: -2 * cw / a0,
        a2: (1 - alpha / A) / a0,
    };
}

function highShelf(sr, f0, gainDb) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * f0 / sr;
    const cw = Math.cos(w0), sw = Math.sin(w0);
    const S = 0.9;
    const alpha = sw / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const sq = 2 * Math.sqrt(A) * alpha;
    const a0 = (A + 1) - (A - 1) * cw + sq;
    return {
        b0: A * ((A + 1) + (A - 1) * cw + sq) / a0,
        b1: -2 * A * ((A - 1) + (A + 1) * cw) / a0,
        b2: A * ((A + 1) + (A - 1) * cw - sq) / a0,
        a1: 2 * ((A - 1) - (A + 1) * cw) / a0,
        a2: ((A + 1) - (A - 1) * cw - sq) / a0,
    };
}

/** |H(e^jw)|² for one normalized biquad section. */
function magSquared(c, w) {
    const cw = Math.cos(w), c2w = Math.cos(2 * w);
    const num = c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2 +
        2 * (c.b0 * c.b1 + c.b1 * c.b2) * cw + 2 * c.b0 * c.b2 * c2w;
    const den = 1 + c.a1 * c.a1 + c.a2 * c.a2 +
        2 * (c.a1 + c.a1 * c.a2) * cw + 2 * c.a2 * c2w;
    return num / den;
}

/** The 3-band EQ's response in dB at each frequency. */
export function eqResponseDb(freqs, { low = 0, mid = 0, high = 0 }, sr = 48000) {
    const sections = [
        lowShelf(sr, 120, low),
        peaking(sr, 1000, 0.7, mid),
        highShelf(sr, 6000, high),
    ];
    return freqs.map(f => {
        const w = 2 * Math.PI * f / sr;
        let db = 0;
        sections.forEach(c => { db += 10 * Math.log10(magSquared(c, w)); });
        return db;
    });
}

/** N log-spaced frequencies over the display range (matches the scope). */
export function logFreqs(n, fLo = 40, fHi = 16000) {
    return Array.from({ length: n },
        (_, i) => fLo * Math.pow(fHi / fLo, i / (n - 1)));
}

/** Echo tap timeline: dry pulse then repeats at k·time, mix·fb^(k−1). */
export function echoTaps({ time, feedback, mix }, horizonS = 4, maxTaps = 12) {
    const taps = [{ t: 0, h: 1, dry: true }];
    let h = mix;
    for (let k = 1; k <= maxTaps; k++) {
        const t = k * time;
        if (t > horizonS || h < 0.02) break;
        taps.push({ t, h, dry: false });
        h *= feedback;
    }
    return taps;
}

/** Visual decay time for the reverb tail (longer room, darker = shorter). */
export function reverbTailSeconds({ size, damp }) {
    return (0.25 + 2.75 * size) * (1 - 0.45 * damp);
}

/**
 * The DURABLE spectrum: a weighted HIGH-WATER-MARK over the live bins
 * (owner ruling 2026-07-12: a symmetric average let silent stretches
 * drag the line into illegibility). Asymmetric per bin: RISE fast
 * toward new maxima (half the gap per poll — a new peak registers in
 * a couple of polls), FALL slowly (fall 0.01/poll ≈ a 5 s time
 * constant at the 20 Hz cadence) — so the line holds the song's tonal
 * shape through gaps and only relaxes when the content really left.
 * Seeds from the first observation; null polls are identity; a
 * bin-count change reseeds.
 */
export function holdSpectrum(prev, next, { rise = 0.5, fall = 0.01 } = {}) {
    if (!next || !next.length) return prev || null;
    if (!prev || prev.length !== next.length) return next.slice();
    return prev.map((v, i) => {
        const d = next[i] - v;
        return v + d * (d > 0 ? rise : fall);
    });
}

/* ---------- canvas painters (Tape Room tokens) ---------- */

const TAPE = '#e8a13c';
const REC = '#d94f30';
const DIM = '#93826d';
const GRID = '#322920';

function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(20, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(20, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
}

/**
 * EQ: live spectrum bars + the DURABLE averaged-spectrum line (cream)
 * behind the bands' analytic response curve (tape).
 */
export function drawEqViz(canvas, spectrum, gains, sr = 48000, avgSpectrum = null) {
    const { ctx, w, h } = fit(canvas);
    // 0 dB midline
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    // Spectrum: one bar per scope bin (already log-spaced 40..16k)
    if (spectrum && spectrum.length) {
        ctx.fillStyle = 'rgba(232, 161, 60, 0.28)';
        const bw = w / spectrum.length;
        spectrum.forEach((s, i) => {
            const bh = Math.max(1, s * h);
            ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
        });
    }
    // The durable line: the song's tonal shape as a slow-falling
    // high-water mark — steady under the flickering bars and through
    // silence; what you actually EQ against
    if (avgSpectrum && avgSpectrum.length) {
        ctx.strokeStyle = 'rgba(239, 230, 216, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const bw = w / avgSpectrum.length;
        avgSpectrum.forEach((s, i) => {
            const x = (i + 0.5) * bw;
            const y = h - s * h;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();
    }
    // Response curve: ±15 dB about the midline
    const freqs = logFreqs(64);
    const dbs = eqResponseDb(freqs, gains, sr);
    ctx.strokeStyle = TAPE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    dbs.forEach((db, i) => {
        const x = (i / (dbs.length - 1)) * w;
        const y = h / 2 - (db / 15) * (h / 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.stroke();
}

/**
 * Compressor: scrolling peak envelope in dB space [−60, 0], the
 * THRESHOLD as a red line across it, and a downward GR meter strip.
 */
export function drawCompViz(canvas, hist, thresholdDb, grDb) {
    const { ctx, w, h } = fit(canvas);
    const meterW = Math.max(6, w * 0.03);
    const waveW = w - meterW - 4;
    const y01 = db => Math.min(1, Math.max(0, (db + 60) / 60));
    // Envelope history (newest right)
    ctx.fillStyle = 'rgba(232, 161, 60, 0.55)';
    const n = hist.length;
    const cw = waveW / Math.max(60, n);
    for (let i = 0; i < n; i++) {
        const db = 20 * Math.log10((hist[i] || 0) + 1e-4);
        const bh = y01(db) * h;
        ctx.fillRect(waveW - (n - i) * cw, h - bh, Math.max(1, cw - 0.5), bh);
    }
    // Threshold line — the whole point of this display
    const ty = h - y01(thresholdDb) * h;
    ctx.strokeStyle = REC;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(0, ty);
    ctx.lineTo(waveW, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    // GR meter: hangs from the top (convention), 24 dB full scale
    ctx.fillStyle = GRID;
    ctx.fillRect(w - meterW, 0, meterW, h);
    ctx.fillStyle = REC;
    ctx.fillRect(w - meterW, 0, meterW, Math.min(1, (grDb || 0) / 24) * h);
}

/** Echo: the tap timeline, breathing with the live signal. */
export function drawEchoViz(canvas, taps, peak, horizonS = 4) {
    const { ctx, w, h } = fit(canvas);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();
    const breathe = 0.6 + 0.4 * Math.min(1, peak || 0);
    taps.forEach(tap => {
        const x = 4 + (tap.t / horizonS) * (w - 8);
        const bh = Math.max(2, tap.h * breathe * (h - 6));
        ctx.fillStyle = tap.dry ? DIM : TAPE;
        ctx.fillRect(x - 1.5, h - 2 - bh, 3, bh);
        ctx.beginPath();
        ctx.arc(x, h - 2 - bh, 2.5, 0, 2 * Math.PI);
        ctx.fill();
    });
}

/** Reverb: dry pulse + exponential tail scaled by mix, glowing live. */
export function drawReverbViz(canvas, tailS, mix, peak, horizonS = 4) {
    const { ctx, w, h } = fit(canvas);
    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();
    const x0 = 6;
    const glow = 0.45 + 0.55 * Math.min(1, peak || 0);
    // Dry pulse
    ctx.fillStyle = DIM;
    ctx.fillRect(x0 - 1.5, 4, 3, h - 6);
    // Wet tail: y = mix · e^(−3t/T)
    ctx.beginPath();
    ctx.moveTo(x0, h - 2);
    const steps = 72;
    for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * horizonS;
        const amp = (mix || 0) * Math.exp(-3 * t / Math.max(0.05, tailS));
        const x = x0 + (t / horizonS) * (w - x0 - 4);
        ctx.lineTo(x, h - 2 - amp * (h - 8));
    }
    ctx.lineTo(w - 4, h - 2);
    ctx.closePath();
    ctx.fillStyle = `rgba(232, 161, 60, ${0.45 * glow})`;
    ctx.fill();
    ctx.strokeStyle = TAPE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * horizonS;
        const amp = (mix || 0) * Math.exp(-3 * t / Math.max(0.05, tailS));
        const x = x0 + (t / horizonS) * (w - x0 - 4);
        const y = h - 2 - amp * (h - 8);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
}

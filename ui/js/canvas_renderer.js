import { log } from './backend.js';

export function drawWaveform(canvas, peaks, fixedStep = null, isComposite = false) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Get dimensions, preferring current canvas size if already set (prevents flicker during drag)
    let width = Math.floor(canvas.clientWidth || canvas.offsetWidth || canvas.parentElement?.clientWidth || 200);
    let height = Math.floor(canvas.clientHeight || canvas.offsetHeight || canvas.parentElement?.clientHeight || 60);

    // Prevent shrinking to 0 during layout transitions (e.g., during drag transforms)
    if (width < 10) width = canvas.width || 200;
    if (height < 10) height = canvas.height || 60;

    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }

    const midY = canvas.height / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background color differs for composite (purple-tinted) vs regular (slate)
    if (isComposite) {
        ctx.fillStyle = 'rgba(88, 28, 135, 0.6)'; // Purple-800 with transparency
    } else {
        ctx.fillStyle = 'rgba(30, 41, 59, 1)'; // Slate
    }
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!peaks || peaks.length === 0) {
        ctx.fillStyle = isComposite ? 'rgba(168, 85, 247, 0.2)' : 'rgba(56, 189, 248, 0.05)';
        ctx.fillRect(0, midY, canvas.width, 1);
        return;
    }

    // Horizontal center line
    ctx.fillStyle = isComposite ? 'rgba(168, 85, 247, 0.3)' : 'rgba(56, 189, 248, 0.1)';
    ctx.fillRect(0, midY, canvas.width, 1);

    // Actual Bars - composite uses purple, regular uses cyan
    ctx.fillStyle = isComposite ? 'rgb(192, 132, 252)' : 'rgb(0, 255, 255)'; // Purple-400 vs Luminous Cyan
    const count = peaks.length;
    // Use fixed step if provided, otherwise calculate dynamically
    const step = fixedStep !== null ? fixedStep : (canvas.width / Math.max(1, count));

    for (let i = 0; i < count; i++) {
        if (peaks[i] === null) continue; // Skip un-recorded segments in circular fill
        const p = parseFloat(peaks[i]) || 0;
        // Round to integer pixels to prevent sub-pixel jitter during recording
        const x = Math.floor(i * step);
        const barWidth = Math.max(1, Math.floor(step));
        const h = Math.max(2, p * (canvas.height * 0.9));
        ctx.fillRect(x, midY - h / 2, barWidth, h);
    }
}


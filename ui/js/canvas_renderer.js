import { log } from './bridge.js';

export function drawWaveform(canvas, peaks) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const width = Math.floor(canvas.clientWidth || canvas.offsetWidth || canvas.parentElement?.clientWidth || 200);
    const height = Math.floor(canvas.clientHeight || canvas.offsetHeight || canvas.parentElement?.clientHeight || 60);

    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }

    const midY = canvas.height / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Initial background
    ctx.fillStyle = 'rgba(30, 41, 59, 1)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!peaks || peaks.length === 0) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.1)';
        ctx.fillRect(0, midY - 1, canvas.width, 2);
        return;
    }

    // Actual Bars
    ctx.fillStyle = 'rgb(0, 255, 255)'; // Luminous Cyan
    const count = peaks.length;
    const step = canvas.width / Math.max(1, count);

    // Keep terminal session logging (reduced frequency)
    if (Math.random() < 0.02) {
        log(`DRAW: ${canvas.width}x${canvas.height}, peaks=${count}, first=${peaks[0]?.toFixed(3)}`);
    }

    for (let i = 0; i < count; i++) {
        if (peaks[i] === null) continue; // Skip un-recorded segments in circular fill
        const p = parseFloat(peaks[i]) || 0;
        const x = i * step;
        const h = Math.max(2, p * (canvas.height * 0.9));
        ctx.fillRect(x, midY - h / 2, Math.max(1, step), h);
    }
}

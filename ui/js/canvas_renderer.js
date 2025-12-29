export function drawWaveform(canvas, peaks) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Ensure canvas has valid dimensions, fallback to parent or defaults
    const width = canvas.clientWidth || canvas.offsetWidth || canvas.parentElement?.clientWidth || 200;
    const height = canvas.clientHeight || canvas.offsetHeight || canvas.parentElement?.clientHeight || 60;

    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }

    const midY = canvas.height / 2;

    // Always clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Diagnostic: Subtle background for visibility
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Diagnostic: Red border for visibility
    ctx.strokeStyle = '#ef444466';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);

    if (Math.random() < 0.05) console.log(`CANVAS DRAW: size=${width}x${height}, peaks=${peaks?.length}`);

    if (!peaks || peaks.length === 0) {
        // Heartbeat line for empty peaks
        ctx.fillStyle = '#38bdf822';
        ctx.fillRect(0, midY - 1, canvas.width, 2);
        return;
    }

    // Drawing style: Robust vertical bars
    ctx.fillStyle = '#7dd3fc'; // Vibrant cyan
    const count = peaks.length;
    // Step should be at least 2px for visibility
    const step = Math.max(2, canvas.width / Math.max(1, count));

    peaks.forEach((p, i) => {
        const x = i * step;

        // Safety check for invalid data
        let peakValue = parseFloat(p);
        if (isNaN(peakValue) || !isFinite(peakValue)) peakValue = 0;

        // Visibility floor: 2px minimal height for recording sessions
        const h = Math.max(2, peakValue * (canvas.height * 0.9));

        // Ensure bar is at least 1.5px wide to prevent alpha-washout
        ctx.fillRect(x, midY - h / 2, Math.max(1.5, step - 0.5), h);
    });
}

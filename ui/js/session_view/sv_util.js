/**
 * Shared micro-helpers for the session view modules: the one Q→%
 * conversion, the idempotent-DOM-write trio, and the small extracted
 * idioms (transition snap, drop-payload parse, guarded pointer
 * capture, element creation) that used to be repeated inline across
 * session_view.js before the 2026-08 split.
 */

export const pct = (q, cycleQ) => (q / cycleQ) * 100 + '%';

/* Q labels: snap fp noise to the whole Q it means (an exactly-1Q map
 * once printed "0.9999…Q" — field 2026-07-25); honest fractions keep
 * two decimals. */
export const fmtQ = q => {
    const r = Math.round(q);
    if (Math.abs(q - r) < 1e-6) return String(r);
    return String(Math.round(q * 100) / 100);
};

/**
 * Idempotent DOM writes. Assigning textContent/innerHTML REPLACES the
 * text node even when the string is identical — and WebKit (the JUCE
 * webview) swallows a click whose mousedown target node is destroyed
 * before mouseup. With a 50ms patch tick, unconditional writes made
 * most human clicks on rail buttons land in a replaced-node window
 * ("clicking collapse did nothing the first several times" — field
 * report 2026-07-09). Never write unless the value changed.
 */
export const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
export const setTitle = (el, s) => { if (el.title !== s) el.title = s; };

export const setStyle = (el, prop, v) => { if (el.style[prop] !== v) el.style[prop] = v; };

/** Element-creation shorthand: tag + class + own-property assignment
 * (textContent, title, …). Styles and listeners stay explicit. */
export const el = (tag, className, props) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (props) Object.assign(node, props);
    return node;
};

/** Disable an element's CSS transition for exactly one layout pass,
 * then restore it — the "snap re-layouts, morph pure moves" idiom.
 * The double rAF guarantees the browser has painted the snapped
 * position before transitions come back on. */
export const snapThenAnimate = node => {
    node.style.transition = 'none';
    requestAnimationFrame(() =>
        requestAnimationFrame(() => { node.style.transition = ''; }));
};

/** Parse a lane-drag drop payload (JSON id array, or a single id from
 * older payloads) into an array of ids; null when unparseable. */
export const parseDropIds = e => {
    let ids;
    try { ids = JSON.parse(e.dataTransfer.getData('text/plain')); }
    catch { return null; }
    if (!Array.isArray(ids)) ids = [ids];
    return ids;
};

/** Pointer capture that survives webviews which refuse it: capture
 * keeps a drag alive off-element, but a synthetic pointer (or a JUCE
 * webview in a bad mood) can throw — the gesture wiring must not die
 * with it. */
export const capturePointer = (node, ev) => {
    try { node.setPointerCapture(ev.pointerId); } catch (_) {}
};

/** True when the key event targets a text-entry control — global
 * hotkeys (zoom, teleport) must never fire while the user types. */
export const isTypingTarget = e => {
    const tag = e.target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
};

/** Approximate Q equality, matching fmtQ's fp-noise tolerance: display
 * decisions (cycle-end label, edge-tick suppression) must not hinge on
 * exact float identity for a fractionally-derived tick. */
export const approxQ = (a, b) => Math.abs(a - b) < 1e-6;

/**
 * Content signature of a ruler tick set, for reconcile keys. The old
 * keys hashed only `cycleQ + tick COUNT` — sound for today's dense
 * integer generator (buildRulerTicks fully determines the set from
 * cycleQ), but silently stale the day ticks are re-bucketed at equal
 * count (audit 2026-08-11). Keying on the rendered content itself
 * (position + major flag per tick, ≤65 entries at the 50ms cadence)
 * removes that class outright.
 */
export const tickSetSig = ticks =>
    ticks.map(t => t.q + (t.major ? 'M' : '')).join(',');

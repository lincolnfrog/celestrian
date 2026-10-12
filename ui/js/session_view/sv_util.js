/**
 * Shared helpers for the session view modules: the one Q→% conversion,
 * the idempotent DOM writes, element creation, and the shared gesture
 * idioms — guarded pointer capture, the held control, the inline rename
 * editor.
 */

export const pct = (q, cycleQ) => (q / cycleQ) * 100 + '%';

/* Lanes indent at most this many levels; deeper ones share the last
 * (`data-depth`, which the stylesheet styles up to here). */
export const MAX_INDENT_DEPTH = 2;

/* Two Q values closer than this are one value: float noise. */
const Q_NOISE = 1e-6;

/* Q labels: snap fp noise to the whole Q it means (an exactly-1Q map
 * must never print "0.9999…Q"); honest fractions keep two decimals. */
export const fmtQ = q => {
    const r = Math.round(q);
    if (Math.abs(q - r) < Q_NOISE) return String(r);
    return String(Math.round(q * 100) / 100);
};

/**
 * IDEMPOTENT DOM WRITES: never write unless the value changed.
 * Assigning textContent REPLACES the text node even when the string is
 * identical, and WebKit (the JUCE webview) swallows a click whose
 * mousedown target node is destroyed before its mouseup — under a 50ms
 * patch tick, an unconditional write would drop most clicks on a rail
 * button.
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

/** Parse a lane-drag drop payload — a JSON id array (a lone JSON value
 * counts as one id) — into an array of ids; null when unparseable. */
export const parseDropIds = e => {
    let ids;
    try { ids = JSON.parse(e.dataTransfer.getData('text/plain')); }
    catch { return null; }
    if (!Array.isArray(ids)) ids = [ids];
    return ids;
};

/** Pointer capture that survives a refusal: capture keeps a drag alive
 * off-element, but setPointerCapture can throw (a synthetic pointer, a
 * webview that declines) — the gesture's wiring must not die with it. */
export const capturePointer = (node, ev) => {
    try { node.setPointerCapture(ev.pointerId); } catch (_) {}
};

/** GESTURE SAFETY NET: `onLost()` fires ONCE if the pointer capture is
 * lost before the gesture's own end ran (WebView2 drops captures on
 * focus loss / Alt-Tab; a synthetic pointer may never deliver its
 * pointerup) or the window blurs — without it the gesture's latches
 * stay set and its closures keep answering. Returns release(): call it
 * from the normal end path. */
export const guardGesture = (node, onLost) => {
    let armed = true;
    const cleanup = () => {
        node.removeEventListener('lostpointercapture', lost);
        window.removeEventListener('blur', lost);
    };
    const lost = () => {
        if (!armed) return;
        armed = false;
        cleanup();
        onLost();
    };
    node.addEventListener('lostpointercapture', lost);
    window.addEventListener('blur', lost);
    return () => { armed = false; cleanup(); };
};

/**
 * A HELD CONTROL (the `_hot` law — context.js): a primary press on
 * `node` holds it until the release, `node._hot` true in between.
 *   onStart(ev) — the press; return false to decline it (nothing held).
 *   onMove(ev)  — each move while held.
 *   onEnd(ev)   — once per hold: `ev` is the release, or null when the
 *                 hold ended without one (cancelled, capture lost,
 *                 window blurred) — nothing was released: commit nothing.
 * The pointer is captured, so the drag outlives the node's bounds.
 * `capture: false` is for a native control that tracks the pointer
 * itself (a range input): its release is caught at the window.
 */
export function holdControl(node, { onStart, onMove, onEnd, capture = true } = {}) {
    node.addEventListener('pointerdown', down => {
        if (down.button !== 0 || node._hot) return;
        if (onStart && onStart(down) === false) return;
        node._hot = true;
        if (capture) capturePointer(node, down);
        const source = capture ? node : window;
        // Heard in the capture phase: at the window that is before any
        // target can stop the event.
        const phase = { capture: true };
        const move = ev => { if (onMove) onMove(ev); };
        const finish = ev => {
            if (!node._hot) return;
            node._hot = false;
            disarm();
            source.removeEventListener('pointermove', move, phase);
            source.removeEventListener('pointerup', finish, phase);
            source.removeEventListener('pointercancel', lost, phase);
            if (onEnd) onEnd(ev);
        };
        const lost = () => finish(null);
        const disarm = guardGesture(node, lost);
        source.addEventListener('pointermove', move, phase);
        source.addEventListener('pointerup', finish, phase);
        source.addEventListener('pointercancel', lost, phase);
    });
}

/**
 * AN INLINE RENAME EDITOR over `nameEl`: the name hides and a text input
 * takes its place, focused, its text selected. Enter or a blur commits,
 * Escape cancels. `onCommit(next)` runs only for a name that CHANGED
 * (trimmed; an empty one only with `allowEmpty`); `onDone()` runs when
 * the editor closes, either way, before the commit.
 */
export function inlineRename(nameEl, { value, maxLength, className,
                                       allowEmpty = false, onCommit, onDone }) {
    const input = el('input', className, { type: 'text' });
    input.value = value;
    input.maxLength = maxLength;
    nameEl.style.display = 'none';
    nameEl.after(input);
    input.focus();
    input.select();
    let done = false;  // Enter removes the input, which blurs it: run once
    const finish = commit => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        input.remove();
        nameEl.style.display = '';
        if (onDone) onDone();
        if (commit && next !== value && (next || allowEmpty)) onCommit(next);
    };
    input.addEventListener('keydown', e => {
        e.stopPropagation();  // typing reaches no hotkey
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
}

/** True when the key event targets a text-entry surface (a form
 * control or a contentEditable editor): no global hotkey fires while
 * the user types. keys.js, the one keydown dispatcher, applies it. */
export const isTypingTarget = e => {
    const t = e.target;
    const tag = t && t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
        !!(t && t.isContentEditable);
};

/** Approximate Q equality, at fmtQ's tolerance: a display decision must
 * not hinge on exact float identity for a fractionally-derived Q. */
export const approxQ = (a, b) => Math.abs(a - b) < Q_NOISE;

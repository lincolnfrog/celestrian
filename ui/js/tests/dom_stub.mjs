/**
 * DOM stand-ins for tests of modules that reach for window / document.
 * Importing this installs nothing: call stubDom() BEFORE the dynamic
 * import of the module under test.
 */

/** Install an inert window and document where the process has none. */
export function stubDom() {
    globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
    globalThis.document ??= {
        activeElement: null,
        getElementById: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
    };
}

/** A node a pointer gesture can listen on and capture; `fire(type, ev)`
 *  runs the listener it holds for `type`. */
export function fakeNode() {
    const listeners = new Map();
    return {
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
        setPointerCapture() {}, hasPointerCapture() { return false; },
        fire(type, ev = {}) { listeners.get(type)?.(ev); },
    };
}

/** The press that starts a gesture. */
export const pointerDown = (pointerId = 1) =>
    ({ preventDefault() {}, stopPropagation() {}, pointerId });

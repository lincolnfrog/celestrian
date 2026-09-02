/**
 * The ONE keyboard dispatcher. Every global hotkey registers here; this
 * module owns the single document-level `keydown` listener, the one
 * typing guard (sv_util.isTypingTarget) and the modifier vocabulary, so
 * no two modules can disagree about "is the user typing?" or about
 * which Escape wins.
 *
 *   registerKey({
 *     key,         // e.key value(s) to match — string or array. A
 *                  // single letter matches case-insensitively ('z' is
 *                  // also 'Z' under Shift / CapsLock).
 *     code,        // alternative: e.code value(s) ('Space').
 *     modifiers,   // REQUIRED modifiers: 'primary' | 'ctrl' | 'meta' |
 *                  // 'alt' | 'shift'. Any held modifier that is neither
 *                  // required nor in `ignore` is a mismatch.
 *     ignore,      // modifiers whose state is irrelevant — ['shift']
 *                  // for hotkeys whose e.key already encodes Shift
 *                  // ('+' / '='); ANY_MODIFIERS for Escape.
 *     when,        // () => boolean, evaluated per event (an open panel).
 *     whileTyping, // true: fires even when the target is a text-entry
 *                  // surface (Escape). Default: the typing guard applies.
 *     scope,       // SCOPE.APP | SCOPE.VIEW | SCOPE.PANEL (any number):
 *                  // higher scopes are tried first, so a modal's Escape
 *                  // beats the session view's Escape.
 *     handler,     // (e) => void | false. A handler that returns false
 *                  // did not consume the key; dispatch continues.
 *   }) → unregister()
 *
 * Within one scope, matches are tried in registration order; the first
 * handler that does not return false consumes the event. Handlers call
 * e.preventDefault() themselves when the browser default must not run.
 *
 * `primary` is the platform's command modifier — ⌘ on macOS, Ctrl
 * elsewhere (normalizeModifiers). The dispatcher accepts EITHER key as
 * primary on every platform: a PC keyboard on a Mac, and the e2e
 * specs' literal `Control+z`, must still undo.
 *
 * NOT routed here, deliberately:
 *   - gesture.js's capture-phase Escape: it must cancel a live drag
 *     before any bubble-phase listener runs and exists only while the
 *     drag is live, so it stays a window capture listener.
 *   - per-input Enter/Escape handlers (rename editors, the creation
 *     menu's template-name field): they stop propagation, so no global
 *     hotkey ever sees keys typed into them.
 */

import { isTypingTarget } from './session_view/sv_util.js';

/** Dispatch scopes, highest tried first. */
export const SCOPE = Object.freeze({ APP: 0, VIEW: 1, PANEL: 2 });

/** `ignore` value for bindings that fire under any modifier state. */
export const ANY_MODIFIERS = Object.freeze(['primary', 'alt', 'shift']);

const IS_MAC = typeof navigator !== 'undefined' &&
    /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');

/** The raw modifier flags each name asserts (all must be held). */
const ASSERTS = Object.freeze({
    primary: ['ctrl', 'meta'],  // either one — see the module comment
    ctrl: ['ctrl'], meta: ['meta'], alt: ['alt'], shift: ['shift'],
});

/**
 * Modifier normalization: `primary` is ⌘ on macOS and Ctrl elsewhere,
 * `secondary` the other of the two. `mac` defaults to the running
 * platform; tests pass it explicitly.
 */
export function normalizeModifiers(e, mac = IS_MAC) {
    const ctrl = !!e.ctrlKey, meta = !!e.metaKey;
    return {
        primary: mac ? meta : ctrl,
        secondary: mac ? ctrl : meta,
        ctrl, meta, alt: !!e.altKey, shift: !!e.shiftKey,
    };
}

const asList = v => v == null ? [] : (Array.isArray(v) ? v : [v]);

function validateNames(names, field) {
    for (const n of names) {
        if (!ASSERTS[n]) throw new Error(`registerKey: unknown ${field} '${n}'`);
    }
}

/** True when the event's held modifiers satisfy the binding. */
function modifiersMatch(binding, e) {
    const held = normalizeModifiers(e);
    for (const name of binding.modifiers) {
        if (name === 'primary') {
            if (!(held.primary || held.secondary)) return false;
        } else if (!held[name]) return false;
    }
    const covered = new Set();
    for (const name of [...binding.modifiers, ...binding.ignore]) {
        for (const flag of ASSERTS[name]) covered.add(flag);
    }
    for (const flag of ['ctrl', 'meta', 'alt', 'shift']) {
        if (held[flag] && !covered.has(flag)) return false;
    }
    return true;
}

const isLetter = k => k.length === 1 && /[a-z]/i.test(k);

function keyMatches(binding, e) {
    for (const k of binding.key) {
        if (isLetter(k)
            ? typeof e.key === 'string' && e.key.toLowerCase() === k.toLowerCase()
            : e.key === k) return true;
    }
    for (const c of binding.code) if (e.code === c) return true;
    return false;
}

const bindings = [];   // sorted: scope descending, then registration order
let sequence = 0;
let installedOn = null;

/**
 * Register one binding (see the module comment). Returns the
 * unregister function. Installs the document listener on first use
 * when a document exists; node tests drive dispatchKey directly.
 */
export function registerKey(spec) {
    const binding = {
        key: asList(spec.key),
        code: asList(spec.code),
        modifiers: asList(spec.modifiers),
        ignore: asList(spec.ignore),
        when: spec.when || null,
        whileTyping: !!spec.whileTyping,
        scope: spec.scope == null ? SCOPE.APP : spec.scope,
        handler: spec.handler,
        order: sequence++,
    };
    if (!binding.key.length && !binding.code.length) {
        throw new Error('registerKey: a key or code is required');
    }
    if (typeof binding.handler !== 'function') {
        throw new Error('registerKey: handler must be a function');
    }
    validateNames(binding.modifiers, 'modifier');
    validateNames(binding.ignore, 'ignore modifier');
    bindings.push(binding);
    bindings.sort((a, b) => b.scope - a.scope || a.order - b.order);
    if (!installedOn) installKeyDispatcher();
    return () => {
        const i = bindings.indexOf(binding);
        if (i >= 0) bindings.splice(i, 1);
    };
}

/**
 * The keydown listener. Returns true when a binding consumed the
 * event. Exported so tests dispatch synthetic events without a DOM.
 */
export function dispatchKey(e) {
    let typing = null;
    for (const b of bindings) {
        if (!keyMatches(b, e) || !modifiersMatch(b, e)) continue;
        if (!b.whileTyping) {
            if (typing === null) typing = isTypingTarget(e);
            if (typing) continue;
        }
        if (b.when && !b.when(e)) continue;
        if (b.handler(e) !== false) return true;
    }
    return false;
}

/**
 * Attach the single keydown listener to `target` (the document by
 * default; a stub in tests). Idempotent while installed. Returns the
 * uninstaller.
 */
export function installKeyDispatcher(target) {
    if (installedOn) return () => {};
    const t = target ||
        (typeof document !== 'undefined' &&
         typeof document.addEventListener === 'function' ? document : null);
    if (!t) return () => {};
    t.addEventListener('keydown', dispatchKey);
    installedOn = t;
    return () => {
        t.removeEventListener('keydown', dispatchKey);
        installedOn = null;
    };
}

/** Number of live bindings (tests). */
export const bindingCount = () => bindings.length;

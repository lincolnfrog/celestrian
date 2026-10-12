/**
 * The session view's popovers: the creation menu, a rail's take list and
 * input menu, the fx row's plugin picker, the sequencer's successors and
 * fades popovers. Each is a transient element, and they share ONE set
 * of rules:
 *
 *   - at most one is open — opening one closes the one before;
 *   - a press on its trigger closes it (closePopoverOf — the trigger's
 *     click then opens nothing);
 *   - a press anywhere else closes it, and so does Escape. That Escape
 *     is the popover's alone (../popover.js: PANEL scope) — the view's
 *     Escape, which clears the selection, waits for the next press.
 *
 * What a popover shows, and where it mounts, stays with its module.
 */

import { wirePopover } from '../popover.js';
import { el } from './sv_util.js';

/* The one open popover: { menu, trigger, onClose }, or null. */
let open = null;
let wired = false;

/** The open popover, or null. One whose element has left the document
 * (its lane was removed under it) is closed here. */
function current() {
    if (open && !open.menu.isConnected) closePopover();
    return open;
}

/** The dismissal rules, wired at the first open. */
function wire() {
    if (wired) return;
    wired = true;
    wirePopover({
        isOpen: () => !!current(),
        open: () => {},
        close: closePopover,
        holds: t => open.menu.contains(t) ||
            !!(open.trigger && open.trigger.contains(t)),
    });
}

/**
 * Show `menu` — appended to `mount` — as THE open popover; whatever was
 * open closes first. `trigger` is the control that opened it (a press on
 * it does not count as outside). `onClose` runs once when it closes,
 * however it closes.
 */
export function openPopover({ menu, trigger, mount, onClose = null }) {
    closePopover();
    wire();
    mount.appendChild(menu);
    open = { menu, trigger, onClose };
}

/** Close the open popover (nothing to do with none open). */
export function closePopover() {
    if (!open) return;
    const { menu, onClose } = open;
    open = null;
    menu.remove();
    if (onClose) onClose();
}

/** The trigger's toggle: close the popover `trigger` opened and answer
 * true; false when it has none open — the caller then opens it. */
export function closePopoverOf(trigger) {
    const o = current();
    if (!o || o.trigger !== trigger) return false;
    closePopover();
    return true;
}

/** The open popover's element when it sits inside `scope`, else null. */
export function openPopoverIn(scope) {
    const o = current();
    return o && scope.contains(o.menu) ? o.menu : null;
}

/** A menu's non-interactive heading / status line. `kind` names the menu
 * ('creation' | 'take' | 'input'): the line is styled per menu. */
export const menuNote = (kind, text) =>
    el('div', kind + '-menu-note', { textContent: text });

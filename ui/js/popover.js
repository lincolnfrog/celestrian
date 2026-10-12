/**
 * One popover's three behaviours: its button toggles it, a press
 * outside closes it, Escape closes it. What the popover is — its
 * element, how it opens, what it shows — stays with the caller.
 *
 * - The outside press is a `pointerdown` heard in the capture phase: a
 *   target that stops its own event still closes the popover, and
 *   "inside" is judged at the press, so a popover that re-renders under
 *   a click does not mistake its own click for an outside one.
 * - Escape is a PANEL-scope binding (keys.js). While the popover is
 *   open it wins over the view's Escape, which would clear the
 *   selection and leave the popover standing.
 */

import { registerKey, SCOPE, ANY_MODIFIERS } from './keys.js';

/**
 * @param {object} spec
 * @param {?EventTarget} [spec.button]  the element whose click toggles
 *        the popover; omit when the caller opens it some other way
 *        (then `holds` must also answer true for whatever opens it)
 * @param {() => boolean} spec.isOpen
 * @param {() => void} spec.open
 * @param {() => void} spec.close
 * @param {(target: EventTarget) => boolean} spec.holds  the press
 *        target is inside the popover
 * @param {EventTarget} [spec.root]  where presses are heard (the
 *        document; a stub in tests)
 * @returns {() => void} unwire
 */
export function wirePopover({ button = null, isOpen, open, close, holds,
                              root = document }) {
    const toggle = () => { if (isOpen()) close(); else open(); };
    const onPress = e => {
        if (!isOpen() || holds(e.target)) return;
        if (button && button.contains(e.target)) return;  // its click toggles
        close();
    };
    if (button) button.addEventListener('click', toggle);
    root.addEventListener('pointerdown', onPress, true);
    const unbindEscape = registerKey({
        key: 'Escape', scope: SCOPE.PANEL, ignore: ANY_MODIFIERS,
        whileTyping: true, when: isOpen, handler: () => close(),
    });
    return () => {
        if (button) button.removeEventListener('click', toggle);
        root.removeEventListener('pointerdown', onPress, true);
        unbindEscape();
    };
}

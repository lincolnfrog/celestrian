/**
 * view_prefs.js — UI-local view preferences (I6b, design_language.md:
 * view actions never change sound; the engine holds no view state).
 *
 * THE FOLD SET: the stack ids whose lanes are collapsed (children
 * hidden). Scoped by project id — a project's folds persist in
 * localStorage under that id; a pre-birth session (no id yet) keeps a
 * session-only set, which migrateFolds carries onto the project the
 * moment it is born. Storage that is missing or refuses (private mode,
 * node) degrades to session-only silently. Stack ids are engine uuids,
 * so a stale id from an earlier graph never matches a live lane.
 */

const STORAGE_PREFIX = 'celestrian.viewPrefs.';
const sets = new Map();  // scope → Set of folded stack ids

function storageKey(scope) {
    return STORAGE_PREFIX + scope + '.folded';
}

function load(scope) {
    if (!scope) return new Set();
    try {
        const raw = globalThis.localStorage?.getItem(storageKey(scope));
        const ids = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(ids)
            ? ids.filter(id => typeof id === 'string') : []);
    } catch {
        return new Set();
    }
}

function save(scope, set) {
    if (!scope) return;
    try {
        globalThis.localStorage?.setItem(storageKey(scope),
                                         JSON.stringify([...set]));
    } catch {
        // Session-only from here: the in-memory set stays authoritative.
    }
}

/** The folded-stack set for `scope` (a project id; '' = pre-birth). */
export function foldedStacks(scope = '') {
    let set = sets.get(scope);
    if (!set) {
        set = load(scope);
        sets.set(scope, set);
    }
    return set;
}

/** Flip stack `id`'s fold in `scope`; returns the new folded state. */
export function toggleFolded(scope, id) {
    const set = foldedStacks(scope);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    save(scope, set);
    return set.has(id);
}

/**
 * Carry `from`'s folds onto `to` (project birth: the pre-birth session
 * set becomes the project's). `to` keeps any folds it already has;
 * `from` is emptied.
 */
export function migrateFolds(from, to) {
    if (from === to) return;
    const source = foldedStacks(from);
    if (!source.size) return;
    const target = foldedStacks(to);
    source.forEach(id => target.add(id));
    source.clear();
    save(from, source);
    save(to, target);
}

/** Drop every in-memory set (tests). Storage is untouched. */
export function resetViewPrefsForTest() {
    sets.clear();
}

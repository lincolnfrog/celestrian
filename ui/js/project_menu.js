/**
 * The project in the chrome (docs/projects.md): a project is a dated
 * folder BORN at the first committed take and mirrored continuously
 * after. This module follows its identity (the menu button is its
 * name), announces the birth, and builds the Project menu — save,
 * rename, duplicate, open, bounce, import, templates, recents.
 */

import { bounceStartOf } from './view_model.js';
import { migrateFolds } from './view_prefs.js';
import { filePathOf } from './import_drop.js';
import { setText, setTitle } from './session_view/sv_util.js';
import { wirePopover } from './popover.js';
import { NO_ANSWER } from './shell_io.js';
import { lastNodesById, lastRootId, lastFrame, lastVm, anyTakeLive,
         hasCommitted } from './session_facts.js';

const PROJECT_POLL_MS = 2000;  // birth and rename follow the mirror
const RECENTS_CAP = 6;         // recent projects shown in the menu

/** The status line for an import's answer (docs/import.md). Both
 * import verbs answer false for a cancel and for a refusal; a lost call
 * never reaches here (shell_io.js `call` says NO_ANSWER). */
export function importVerdict(result, what, takeLive) {
    if (result) return `Imported${what ? ' ' + what : ''} — ⌘Z to undo`;
    if (takeLive) return 'Import refused — a take is live';
    return 'Import cancelled — or refused: audio files land on audio ' +
        'tracks (WAV, AIFF, FLAC)';
}

/** The status line for a bounce's answer (docs/bounce.md). */
export function bounceVerdict(result, takeLive) {
    if (result) return 'Bounced';
    return takeLive ? 'Bounce refused — a take is live' : 'Bounce cancelled';
}

/** The absolute origin of a placement `q` whole Qs into the frame at
 * rest (session_facts.js lastFrame); 0 before a frame exists, when the
 * engine takes the clock instead. */
export function importOriginAt(q, frame) {
    return frame ? frame.rest + q * frame.quantum : 0;
}

/**
 * @param {object} deps
 * @param {object} deps.io  createShellIo's io
 * @param {(create: () => Promise<*>) => Promise<*>} deps.createAndSelect
 *        run a creation verb and select what it made (structure_verbs.js)
 * @param {() => ?string} deps.soleSelectedId  the selected lane when
 *        exactly one is selected
 */
export function createProjectMenu({ io, createAndSelect, soleSelectedId }) {
    const { callNative, setLogLine, call, takeLiveNow } = io;

    let info = { id: '', name: '', born: false };
    // Set when an open verb lands: the next refresh reads a project
    // that was OPENED, and its `born` flag flipping is no birth.
    let opened = false;

    /**
     * Read the project's identity and mirror it into the chrome. The
     * first refresh that sees `born` flip without an open announces the
     * birth and carries the unborn session's folds onto the project
     * (view_prefs.js); `announceSave` says "Saved …" instead. A lost
     * or failed read keeps the last good identity; the next tick asks
     * again.
     */
    async function refresh(announceSave = false) {
        const next = await callNative('getProjectInfo').catch(() => null);
        if (!next || typeof next !== 'object') return;
        const birth = !info.born && next.born && !opened;
        opened = false;
        info = next;
        if (birth) migrateFolds('', next.id);
        // Guarded writes: the button is clickable (session_view.md, the
        // patch law).
        const btn = document.getElementById('project-menu-btn');
        if (btn) {
            setText(btn, next.born ? `${next.name} ▾` : 'Project ▾');
            setTitle(btn, next.born
                ? `${next.id} — save, rename, templates`
                : 'Project — save, rename, templates');
        }
        if (birth) {
            setLogLine(`Project ${next.id} created — mirroring to disk`);
        } else if (announceSave && next.born) {
            setLogLine(`Saved ${next.name}`);
        }
    }

    /** Checkpoint the project (the menu's item and ⌘S). The mirror
     * already saves continuously; an explicit save births an unborn
     * project and stamps the folder now. "Saved" is said from the
     * identity read after a save that reached the disk. */
    const save = async () => {
        const saved = await callNative('saveProjectNow');
        await refresh(!!saved);
        if (!saved) {
            setLogLine(saved === null ? NO_ANSWER
                : 'Not saved — the project folder could not be written');
        }
    };

    /** For a verb that answered `result`: was it refused with a take
     * live? Asked of the graph as it is then, and only on a refusal. */
    const refusedByTake = result => (result ? false : takeLiveNow());

    /** Run a verb that replaces the session with a stored project, say
     * how it went, and adopt its identity — as an open, never a birth. */
    async function open(method, args, okMsg, failMsg) {
        if (await call(method, args, okMsg, failMsg)) opened = true;
        return refresh();
    }

    /** The native folder chooser (the menu's item and ⌘O). */
    const openWithDialog = () =>
        open('loadSession', [''], 'Project opened', 'Open cancelled');

    /** Import through the native chooser into `targetId` (the root
     * when none), placed `q` whole Qs into the frame. */
    function importWithDialog(targetId, q) {
        const id = targetId || lastRootId;
        if (!id) return Promise.resolve(false);
        return createAndSelect(() => call('importAudioWithDialog',
            [id, importOriginAt(q, lastFrame)],
            async r => importVerdict(r, q > 0 ? `at Q${q}` : '', await refusedByTake(r))));
    }

    /** An OS file dropped on a lane at frame Q `q`: the first file
     * imports by its path, or through the chooser when the host hands
     * the page only its name (import_drop.js). */
    function onImportDrop(laneId, q, files) {
        const file = files && files[0];
        const path = filePathOf(file);
        if (!path) return importWithDialog(laneId, q);
        return createAndSelect(() => call('importAudio',
            [laneId, path, importOriginAt(q, lastFrame)],
            async r => importVerdict(r, `${file.name} at Q${q}`, await refusedByTake(r))));
    }

    /** Bounce node `id` through the native save dialog, from `start`
     * (absolute samples) or the engine's default. */
    const bounceTo = (id, start = null) =>
        call('bounceWithDialog', start === null ? [id] : [id, start],
            async r => bounceVerdict(r, await refusedByTake(r)));

    /**
     * Build the menu into `menu`; it is rebuilt on every open, so
     * templates and recents are fresh. Static items render at once; the
     * template and recents sections append when their reads answer.
     */
    function build(menu) {
        menu.textContent = '';
        const close = () => menu.classList.remove('open');
        const item = (label, fn, disabled = false) => {
            const b = document.createElement('button');
            b.className = 'pm-item';
            b.textContent = label;
            b.disabled = disabled;
            b.addEventListener('click', () => { close(); fn(); });
            menu.appendChild(b);
            return b;
        };
        const head = label => {
            const d = document.createElement('div');
            d.className = 'pm-head';
            d.textContent = label;
            menu.appendChild(d);
        };
        const sep = () => {
            const d = document.createElement('div');
            d.className = 'pm-sep';
            menu.appendChild(d);
        };
        // A text input with one action (rename, save-as-template).
        const inlineRow = (placeholder, initial, actionLabel, onCommit) => {
            const row = document.createElement('div');
            row.className = 'pm-inline';
            const input = document.createElement('input');
            input.placeholder = placeholder;
            input.value = initial || '';
            const go = document.createElement('button');
            go.textContent = actionLabel;
            go.addEventListener('click', () => {
                const v = input.value.trim();
                if (v) { close(); onCommit(v); }
            });
            input.addEventListener('keydown', ev => {
                if (ev.key === 'Enter') go.click();
                if (ev.key === 'Escape') close();
                ev.stopPropagation();
            });
            row.append(input, go);
            menu.appendChild(row);
        };

        const born = info.born;
        item(born ? `Save now (${info.name})` : 'Save now — creates today’s project',
            save);
        if (born) {
            head('Rename (the folder never moves)');
            inlineRow('project name', info.name, 'Rename', name =>
                call('renameProject', [name], 'Project renamed (folder unchanged)')
                    .then(() => refresh()));
        }
        item('Duplicate project (next serial)', () =>
            call('duplicateProject', [],
                id => `Forked to ${id} — the original stays as a checkpoint`,
                'Nothing to duplicate yet')
                .then(() => refresh()), !born);
        item('Open project folder…', openWithDialog);

        // Bounce (docs/bounce.md): the song is the root for one cycle,
        // from the frame at rest, so the file starts where the picture
        // starts. A single selected lane bounces from its ↺ as shown
        // (bounceStartOf), so a stem opens on the sample the song does.
        sep();
        const songHasContent = lastRootId &&
            [...lastNodesById.values()].some(hasCommitted);
        item('Bounce song…',
             () => bounceTo(lastRootId, lastFrame ? lastFrame.rest : null),
             !songHasContent);
        const sel = lastNodesById.get(soleSelectedId());
        if (sel) {
            item('Bounce selected…',
                 () => bounceTo(sel.id, bounceStartOf(lastVm, sel.id)),
                 !hasCommitted(sel));
        }

        // A new track from a file, at the frame top.
        item('Import audio…', () => importWithDialog(lastRootId, 0),
             !lastRootId || anyTakeLive());

        sep();
        head('Save as template');
        inlineRow('e.g. My Rig', '', 'Save', name =>
            call('saveAsTemplate', [name],
                `Template "${name}" saved — Project ▾ → New from template`,
                'Template save failed'));

        callNative('listTemplates').then(answer => {
            const templates = Array.isArray(answer) ? answer : [];
            if (!templates.length) return;
            sep();
            head('New from template');
            templates.forEach(t => item(t.name, () =>
                call('newProjectFromTemplate', [t.id],
                    `Template "${t.name}" loaded — play the seed`,
                    'Template failed to load')
                    .then(() => refresh())));
        });
        callNative('listRecentProjects').then(answer => {
            const recents = Array.isArray(answer) ? answer : [];
            if (!recents.length) return;
            sep();
            head('Recent projects');
            recents.slice(0, RECENTS_CAP).forEach(r => item(
                r.name === r.id ? r.id : `${r.name} · ${r.id}`, () =>
                open('openProjectPath', [r.path],
                     `Opened ${r.name}`, 'Open failed')));
        });
    }

    /** Wire the menu button and start following the project. */
    function init() {
        const button = document.getElementById('project-menu-btn');
        const menu = document.getElementById('project-menu');
        if (button && menu) {
            wirePopover({
                button,
                isOpen: () => menu.classList.contains('open'),
                open: () => { build(menu); menu.classList.add('open'); },
                close: () => menu.classList.remove('open'),
                holds: target => menu.contains(target),
            });
        }
        refresh();
        setInterval(refresh, PROJECT_POLL_MS);
    }

    return {
        init, refresh, save, openWithDialog, importWithDialog, onImportDrop,
        /** The project's id; '' before it is born. */
        id: () => info.id,
    };
}

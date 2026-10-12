/**
 * mock/projects.js — the project model (docs/projects.md; engine
 * ProjectManager) and session save / load, in memory: a saved session is
 * the serialized graph kept under its path, and the projects "disk" is a
 * handful of lists.
 */

import { committedClipCount, takeLive, serializeGraph, restoreGraph, settleAnchors }
    from './state.js';
import { clearUndoHistory } from './undo.js';
import { loadScenario } from './scenarios.js';

const savedSessions = new Map();  // path → serialized graph

export function saveSession(path) {
    savedSessions.set(String(path), serializeGraph());
    return true;
}

/** False for a path that holds no session. A load drops the history. */
export function loadSession(path) {
    const saved = savedSessions.get(String(path));
    if (!saved) return false;
    restoreGraph(saved);
    settleAnchors();
    clearUndoHistory();
    return true;
}

const projects = {
    current: { id: '', name: '', born: false },
    recents: [],  // [{ id, name, path }]
    templates: [{ id: 'My Rig', name: 'My Rig', path: '/templates/My Rig' }],
    serial: 0,
    base: '/Users/mock/Music/Celestrian',
};

/** The folder the dialog verb "picks". */
export const CHOSEN_ROOT = '/Volumes/Studio/Celestrian';

function projectDateId() {
    const d = new Date();
    const ymd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    projects.serial += 1;
    return `${ymd}-${String(projects.serial).padStart(2, '0')}`;
}

function birth(name = null) {
    const id = projectDateId();
    projects.current = { id, name: name || id, born: true };
    projects.recents.unshift({ id, name: projects.current.name, path: '/projects/' + id });
    return id;
}

/** A project is born at its first committed take, checked on this poll. */
export function getProjectInfo() {
    if (!projects.current.born && committedClipCount() > 0 && !takeLive()) birth();
    return {
        ...projects.current,
        projectsRoot: projects.base + '/Projects',
        trackTemplatesRoot: projects.base + '/TrackTemplates',
    };
}

export function setProjectsRoot(path) {
    const p = String(path || '').trim();
    if (!p) return false;
    projects.base = p.replace(/\/+$/, '');
    return true;
}

export function chooseProjectsRoot() {
    setProjectsRoot(CHOSEN_ROOT);
    return CHOSEN_ROOT;
}

/** The display name only: the id (the folder) never changes. */
export function renameProject(name) {
    if (name && name.trim()) projects.current.name = name.trim();
    const recent = projects.recents.find(x => x.id === projects.current.id);
    if (recent) recent.name = projects.current.name;
    return true;
}

/** An explicit save births an unborn project at once. */
export function saveProjectNow() {
    if (!projects.current.born) birth();
    return true;
}

/** [{ id, name, path }] — a copy: the caller's list is its own. */
export function listTemplates() {
    return projects.templates.map(t => ({ ...t }));
}

export function listRecentProjects() {
    return projects.recents.map(r => ({ ...r }));
}

/** A template is structure only: the mock resets to an empty session.
 * False for an id the library does not hold. */
export function newProjectFromTemplate(id) {
    if (!projects.templates.some(t => t.id === id)) return false;
    loadScenario('empty');
    projects.current = { id: '', name: '', born: false };
    return true;
}

export function openProjectPath(path) {
    const recent = projects.recents.find(x => x.path === path);
    if (!recent) return false;
    projects.current = { id: recent.id, name: recent.name, born: true };
    return true;
}

/** The template's folder is the name's legal-file-name form (engine:
 * juce::File::createLegalFileName); a name with nothing legal in it, or
 * one that is only dots, names no folder and is refused. */
export function saveAsTemplate(name) {
    const typed = String(name || '').trim();
    const id = typed.replace(/["#@,;:<>*^|?\\/]/g, '').trim();
    if (!id || /^\.+$/.test(id)) return false;
    if (!projects.templates.some(t => t.id === id)) {
        projects.templates.push({ id, name: typed, path: '/templates/' + id });
    }
    return true;
}

export function duplicateProject() {
    if (!projects.current.born) return '';
    return birth(projects.current.name);
}

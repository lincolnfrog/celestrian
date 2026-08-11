/**
 * mock/projects.js — the project model (docs/projects.md) mirrored in
 * memory, plus session save/load (the in-memory stand-in for
 * session_io's session.json + audio/ bundle). All the handlers'
 * project-shaped bodies live here as named functions.
 */

import { committedClipCount, anyNodeRecording,
         serializeGraph, restoreGraph } from './state.js';
import { clearUndoHistory } from './undo.js';
import { loadScenario } from './scenarios.js';

// Save/Load (mirrors AudioEngine's session_io observably). The mock keeps
// the bundle in memory instead of a session.json + audio/ directory, so
// e2e can round-trip without a filesystem. Load clears undo history.
let mockSavedSession = null;

export function saveSession(_path) {
    mockSavedSession = serializeGraph();
    return true;
}

export function loadSession(_path) {
    if (!mockSavedSession) return false;
    restoreGraph(mockSavedSession);
    clearUndoHistory();
    return true;
}

// --- The project model (docs/projects.md), mirrored in memory ---
// The mock keeps a fake projects "disk" so the UI's birth/rename/template
// flows are drivable in the browser and by e2e. Birth parity: first
// committed take (checked on getProjectInfo polls — the mock's tick).
const mockProjects = {
    current: { id: '', name: '', born: false },
    recents: [],                  // [{id, name, path}]
    templates: [{ id: 'My Rig', name: 'My Rig', path: '/templates/My Rig' }],
    serial: 0,
};

function projectDateId() {
    const d = new Date();
    const ymd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    mockProjects.serial += 1;
    return `${ymd}-${String(mockProjects.serial).padStart(2, '0')}`;
}

export function getProjectInfo() {
    // Birth at first committed take (ProjectManager::tick parity).
    if (!mockProjects.current.born && committedClipCount() > 0 &&
        !anyNodeRecording()) {
        const id = projectDateId();
        mockProjects.current = { id, name: id, born: true };
        mockProjects.recents.unshift({ id, name: id, path: '/projects/' + id });
        console.log('[MockBackend] Project born:', id);
    }
    return JSON.stringify(mockProjects.current);
}

export function renameProject(name) {
    // Display name only — the id (folder) never changes.
    if (name && name.trim()) mockProjects.current.name = name.trim();
    const r = mockProjects.recents.find(x => x.id === mockProjects.current.id);
    if (r) r.name = mockProjects.current.name;
    return true;
}

// An explicit save births an unborn project immediately (no tick wait).
export function saveProjectNow() {
    if (!mockProjects.current.born) {
        const id = projectDateId();
        mockProjects.current = { id, name: id, born: true };
        mockProjects.recents.unshift({ id, name: id, path: '/projects/' + id });
    }
    return true;
}

export function listTemplates() {
    return JSON.stringify(mockProjects.templates);
}

export function listRecentProjects() {
    return JSON.stringify(mockProjects.recents);
}

export function newProjectFromTemplate(_name) {
    // Template = structure only, pre-Q: the mock resets to an empty
    // session (scenario graphs stand in for template structure).
    loadScenario('empty');
    mockProjects.current = { id: '', name: '', born: false };
    return true;
}

export function openProjectPath(path) {
    const r = mockProjects.recents.find(x => x.path === path);
    if (!r) return false;
    mockProjects.current = { id: r.id, name: r.name, born: true };
    return true;
}

export function saveAsTemplate(name) {
    if (!name || !name.trim()) return false;
    const n = name.trim();
    if (!mockProjects.templates.some(t => t.id === n)) {
        mockProjects.templates.push({ id: n, name: n, path: '/templates/' + n });
    }
    return true;
}

export function duplicateProject() {
    if (!mockProjects.current.born) return '';
    const id = projectDateId();
    const name = mockProjects.current.name;
    mockProjects.current = { id, name, born: true };
    mockProjects.recents.unshift({ id, name, path: '/projects/' + id });
    return id;
}

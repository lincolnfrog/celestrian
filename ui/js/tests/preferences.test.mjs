/**
 * The preferences panel (session_view.md §2): the pure helpers preferences.js
 * and audio_settings.js export, and the mock's projects-root verbs —
 * getProjectInfo publishes the root, setProjectsRoot moves it (an
 * empty path is refused), chooseProjectsRoot picks the mock's fixed
 * folder and answers it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { rootDisplay, calibrationStartLine } from '../preferences.js';
import { deviceChangeVerdict } from '../audio_settings.js';
import { callNative, loadScenario } from '../mock_backend.js';
import { CHOSEN_ROOT } from '../mock/projects.js';

test('rootDisplay: the published root, or the placeholder — a lost read included', () => {
    assert.equal(rootDisplay({ projectsRoot: '/Music/Celestrian/Projects' }),
        '/Music/Celestrian/Projects');
    assert.equal(rootDisplay({ projectsRoot: '  ' }), '— not set —');
    assert.equal(rootDisplay({}), '— not set —');
    assert.equal(rootDisplay(null), '— not set —');
});

test('calibrationStartLine: started, refused because one is already running, or lost', () => {
    assert.match(calibrationStartLine(true), /^Calibrating…/);
    assert.match(calibrationStartLine(false), /already running/);
    assert.equal(calibrationStartLine(null), null);
});

test('deviceChangeVerdict: "" is success, text is the engine\'s error, null is a lost call', () => {
    assert.equal(deviceChangeVerdict(''), 'Audio device updated.');
    assert.equal(deviceChangeVerdict('No such device'),
        'Audio device error: No such device');
    assert.equal(deviceChangeVerdict(null),
        'Audio device not changed — the engine did not answer');
});

test('the mock projects root: published, settable, chosen', async () => {
    loadScenario('empty');
    const info = await callNative('getProjectInfo');
    assert.equal(info.projectsRoot, '/Users/mock/Music/Celestrian/Projects');
    assert.equal(info.trackTemplatesRoot, '/Users/mock/Music/Celestrian/TrackTemplates');

    assert.equal(await callNative('setProjectsRoot', ''), false);
    assert.equal(await callNative('setProjectsRoot', '/Volumes/Tape/'), true);
    assert.equal((await callNative('getProjectInfo')).projectsRoot,
        '/Volumes/Tape/Projects');

    assert.equal(await callNative('chooseProjectsRoot'), CHOSEN_ROOT);
    assert.equal((await callNative('getProjectInfo')).projectsRoot,
        CHOSEN_ROOT + '/Projects');
});

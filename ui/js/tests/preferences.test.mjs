/**
 * The preferences panel (session_view.md §2): the pure helpers preferences.js
 * and audio_settings.js export, and the mock's projects-root verbs —
 * getProjectInfo publishes the root, setProjectsRoot moves it (an
 * empty path is refused), chooseProjectsRoot picks the mock's fixed
 * folder and answers it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { rootDisplay, parseProjectInfo } from '../preferences.js';
import { deviceSummary } from '../audio_settings.js';
import { callNative, loadScenario } from '../mock_backend.js';
import { CHOSEN_ROOT } from '../mock/projects.js';

test('rootDisplay: the published root, or the placeholder', () => {
    assert.equal(rootDisplay({ projectsRoot: '/Music/Celestrian/Projects' }),
        '/Music/Celestrian/Projects');
    assert.equal(rootDisplay({ projectsRoot: '  ' }), '— not set —');
    assert.equal(rootDisplay({}), '— not set —');
    assert.equal(rootDisplay(null), '— not set —');
});

test('parseProjectInfo: JSON text or an object; null when unreadable', () => {
    assert.deepEqual(parseProjectInfo('{"id":"x","born":true}'), { id: 'x', born: true });
    assert.deepEqual(parseProjectInfo({ id: 'y' }), { id: 'y' });
    assert.equal(parseProjectInfo('not json'), null);
    assert.equal(parseProjectInfo(''), null);
    assert.equal(parseProjectInfo(undefined), null);
});

test('deviceSummary: one line per device state', () => {
    assert.equal(deviceSummary(null), 'No audio device open');
    assert.equal(deviceSummary({ currentDevice: '' }), 'No audio device open');
    assert.equal(deviceSummary({ currentDevice: 'MOTU 8A', inputChannels: 8,
                                 currentSampleRate: 48000, currentBufferSize: 256 }),
        'MOTU 8A · 8 in · 48 kHz / 256');
});

test('the mock projects root: published, settable, chosen', async () => {
    loadScenario('empty');
    const info = parseProjectInfo(await callNative('getProjectInfo'));
    assert.equal(info.projectsRoot, '/Users/mock/Music/Celestrian/Projects');
    assert.equal(info.trackTemplatesRoot, '/Users/mock/Music/Celestrian/TrackTemplates');

    assert.equal(await callNative('setProjectsRoot', ''), false);
    assert.equal(await callNative('setProjectsRoot', '/Volumes/Tape/'), true);
    assert.equal(parseProjectInfo(await callNative('getProjectInfo')).projectsRoot,
        '/Volumes/Tape/Projects');

    assert.equal(await callNative('chooseProjectsRoot'), CHOSEN_ROOT);
    assert.equal(parseProjectInfo(await callNative('getProjectInfo')).projectsRoot,
        CHOSEN_ROOT + '/Projects');
});

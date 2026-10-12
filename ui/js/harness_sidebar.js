/**
 * The scenario sidebar of the mock page (`/?mock=true&harness=1`): one
 * button per mock scenario (mock/scenarios.js), in flow beside the app,
 * for working on the UI by hand. backend.js mounts it in MOCK mode; the
 * app knows nothing of it.
 */

/** [scenario id, button label] — or a bare string, a group heading. */
const SCENARIOS = [
    ['empty', 'Empty session'],
    ['single-clip', 'Single Clip'],
    ['stack-with-clips', 'Stack with 3 Clips'],
    ['multiple-stacks', 'Multiple Stacks'],
    'Recording.md examples',
    ['example-1q-4q', '1Q + 4Q (LCM=4)'],
    ['example-1q-4q-3q', '1Q + 4Q + 3Q (LCM=12)'],
    'Recording tests',
    ['recording-1q-plus-growing', '1Q + Recording'],
    ['clip-3-anchor-at-2q', '1Q + 4Q + 1Q@2Q (Anchor)'],
    ['1q-3q-loop-bug', '1Q + 3Q (Loop)'],
    'Nested stacks',
    ['nested-stacks', 'Nested Stacks'],
    ['fractal-drums', 'Fractal Drums'],
    'Q hand-off',
    ['keys-then-drums', 'Keys then Drums'],
    'MIDI',
    ['midi-clip', 'MIDI Clip'],
];

/** The scenario the mock boots on (mock/scenarios.js). */
const BOOT_SCENARIO = 'empty';

const SIDEBAR_WIDTH_PX = 240;

/* The sidebar sits in flow to the right of the app, so it never covers
 * a lane. Its palette is deliberately not the app's: harness chrome
 * must be unmistakable in a screenshot. */
const STYLE = `
body.harness { display: grid; grid-template-columns: minmax(0, 1fr) ${SIDEBAR_WIDTH_PX}px; }
body.harness #app { min-width: 0; overflow: hidden; }
#test-controls {
    background: #201a15;
    border-left: 1px solid #322920;
    padding: 12px;
    overflow-y: auto;
    font-size: 12px;
}
#test-controls h3 { margin: 0 0 10px; font-size: 13px; color: #e8a13c; }
#test-controls .group-label {
    margin: 12px 0 6px;
    color: #93826d;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 10px;
}
#test-controls button {
    display: block;
    width: 100%;
    margin-bottom: 6px;
    padding: 8px;
    font-size: 12px;
}
#test-controls button.active { border-color: #e8a13c; color: #e8a13c; }
#mock-status {
    margin-top: 12px;
    color: #93826d;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 10px;
}`;

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
};

/**
 * Mount the sidebar beside `#app`. `loadScenario(id)` is the mock's
 * (window.__celestrianTest.loadScenario); the button of the scenario on
 * show is marked.
 */
export function mountHarnessSidebar(loadScenario) {
    const style = el('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    const bar = el('aside');
    bar.id = 'test-controls';
    bar.appendChild(el('h3', '', '🧪 Test Scenarios'));
    const buttons = [];
    for (const entry of SCENARIOS) {
        if (typeof entry === 'string') {
            bar.appendChild(el('div', 'group-label', entry));
            continue;
        }
        const [id, label] = entry;
        const button = el('button', id === BOOT_SCENARIO ? 'active' : '', label);
        button.dataset.scenario = id;
        button.addEventListener('click', () => {
            loadScenario(id);
            for (const b of buttons) b.classList.toggle('active', b === button);
        });
        buttons.push(button);
        bar.appendChild(button);
    }
    const status = el('div', '', 'Using Mock Backend');
    status.id = 'mock-status';
    bar.appendChild(status);

    document.body.classList.add('harness');
    document.body.appendChild(bar);
}

import { callNative, log } from './bridge.js';
import { drawWaveform } from './canvas_renderer.js';
import { Viewport } from './viewport.js';

const nodeLayer = document.getElementById('node-layer');
const creationUI = document.getElementById('creation-ui');
const creationMenu = document.getElementById('creation-menu');
const playBtn = document.getElementById('play-btn');

const livePeaks = new Map();
let viewport;

// Global API Hooks (Moved to top for reliable early initialization)
window.toggleCreationMenu = (e) => {
    if (e) e.stopPropagation();
    const menu = document.getElementById('creation-menu');
    const active = menu.classList.toggle('active');
    console.log("Toggle Menu (v2.0.2):", active);

    const btn = document.querySelector('.btn-plus-circle');
    if (btn) {
        btn.style.background = '#ffffff';
        setTimeout(() => btn.style.background = '', 100);
    }
};

window.createNode = (type) => {
    const menu = document.getElementById('creation-menu');
    if (menu) menu.classList.remove('active');
    callNative('create_node', type);
};

window.exitBox = () => callNative('exit_box');
window.togglePlayback = () => callNative('toggle_playback');
window.toggleRecord = (id) => toggleRecord(id);

export function initApp() {
    viewport = new Viewport(document.getElementById('viewport'), document.getElementById('canvas-root'));

    // Global Keyboard Listeners
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;

        if (e.code === 'Space') {
            e.preventDefault();
            togglePlayback();
        }
        if (e.key === 'Escape') exitBox();

        const step = 25 / viewport.scale;
        if (e.key === 'w') viewport.pan(0, step);
        if (e.key === 's') viewport.pan(0, -step);
        if (e.key === 'a') viewport.pan(step, 0);
        if (e.key === 'd') viewport.pan(-step, 0);
        if (e.key === 'q') viewport.zoom(1.1);
        if (e.key === 'e') viewport.zoom(0.9);
    });

    // Global click listener to close menus
    window.addEventListener('click', (e) => {
        const menu = document.getElementById('creation-menu');
        const ui = document.getElementById('creation-ui');
        if (menu && ui && !ui.contains(e.target)) {
            menu.classList.remove('active');
        }
    });

    // Transport buttons click
    const backBtn = document.getElementById('back-btn');
    if (backBtn) {
        backBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            exitBox();
        });
    }

    if (playBtn) {
        playBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            togglePlayback();
        });
    }

    startPolling();
}

async function startPolling() {
    console.log("Starting state polling loop...");
    while (true) {
        try {
            const state = await callNative('get_graph_state');
            if (state) syncUI(state);
        } catch (err) {
            console.error("Polling error:", err);
        }
        await new Promise(r => setTimeout(r, 50));
    }
}

function syncUI(state) {
    // Playback state
    const isPlaying = state.is_playing;
    playBtn.classList.toggle('playing', isPlaying);
    playBtn.innerText = isPlaying ? "STOP" : "PLAY";

    const nodes = state.nodes || [];
    const newNodeIds = nodes.map(n => n.id);
    const uiNodeIds = Array.from(nodeLayer.children).map(c => c.id);

    let maxY = 0;
    let minX = Infinity;
    let maxX = -Infinity;

    nodes.forEach(node => {
        let div = document.getElementById(node.id);
        if (!div) {
            div = createNodeElement(node);
            nodeLayer.appendChild(div);
        }

        div.style.left = `${node.x}px`;
        div.style.top = `${node.y}px`;
        div.style.width = `${node.w}px`;
        div.style.height = `${node.h}px`;

        maxY = Math.max(maxY, node.y + node.h);
        minX = Math.min(minX, node.x);
        maxX = Math.max(maxX, node.x + node.w);

        const recBtn = div.querySelector('.node-btn-record');
        recBtn.classList.toggle('active', node.is_recording);
        const playhead = div.querySelector('.playhead');
        playhead.style.left = `${node.playhead * 100}%`;

        // Diagnostic: Peak text
        const peakInfo = div.querySelector('.peak-debug');
        if (peakInfo) {
            const pVal = node.current_peak || 0;
            peakInfo.innerText = pVal.toFixed(4); // More precision to see activity
            if (pVal > 0.001) peakInfo.style.opacity = "1";
            else peakInfo.style.opacity = "0.4";
        }

        // Diagnostic: Log recording state change
        if (node.is_recording !== div._last_rec_state) {
            log(`Node ${node.id} is_recording: ${node.is_recording}`);
            div._last_rec_state = node.is_recording;
        }

        if (node.is_recording) {
            if (!livePeaks.has(node.id)) livePeaks.set(node.id, []);
            const peaks = livePeaks.get(node.id);
            // Visibility floor: ensure we see something even in silence
            const p = node.current_peak > 0.005 ? node.current_peak : 0.01;
            peaks.push(p);
            if (peaks.length > 300) peaks.shift();

            if (Math.random() < 0.05) {
                const samples = peaks.slice(-3).map(v => v.toFixed(3)).join(', ');
                log(`REC ${node.name}: [${samples}] count=${peaks.length}`);
            }
            drawWaveform(div.querySelector('.node-waveform'), peaks);
        } else if (node.duration > 0) {
            // Check if we just stopped recording - the size will be small if it's the live buffer
            if (!livePeaks.has(node.id) || livePeaks.get(node.id).length < 20) {
                fetchWaveform(node.id);
            }
            const pks = livePeaks.get(node.id) || [];
            if (Math.random() < 0.05) {
                const samples = pks.slice(0, 3).map(v => v ? v.toFixed(3) : '0').join(', ');
                console.log(`SYNC STATIC: uuid=${node.id.slice(0, 4)}, name=${node.name}, peaks=${pks.length}, head=${samples}`);
            }
            drawWaveform(div.querySelector('.node-waveform'), pks);
        }
        else {
            // Only clear if we really have no data
            if (livePeaks.has(node.id)) {
                drawWaveform(div.querySelector('.node-waveform'), livePeaks.get(node.id));
            } else {
                drawWaveform(div.querySelector('.node-waveform'), []);
            }
        }
    });

    // Removal check
    uiNodeIds.forEach(id => {
        if (!newNodeIds.includes(id)) {
            const el = document.getElementById(id);
            if (el) el.remove();
            livePeaks.delete(id);
        }
    });
}

function createNodeElement(node) {
    const div = document.createElement('div');
    div.id = node.id;
    div.className = `node ${node.type}`;
    div.innerHTML = `
        <div class="node-header">
            <input class="node-name-input" value="${node.name}" />
            <span class="peak-debug" style="font-size: 9px; color: #10b981; opacity: 0.6; pointer-events: none; flex-grow: 1; text-align: right; padding-right: 8px;"></span>
            <div class="node-btn-record" style="width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">
                <div class="record-dot" style="width: 12px; height: 12px; border-radius: 50%; background: #334155;"></div>
            </div>
        </div>
        <div class="node-content">
            <canvas class="node-waveform" style="position: relative; z-index: 5;"></canvas>
            <div class="playhead"></div>
        </div>
    `;

    // Events
    const input = div.querySelector('.node-name-input');
    input.onblur = () => renameNode(node.id, input.value);
    input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
        e.stopPropagation();
    };

    div.querySelector('.node-btn-record').onmousedown = (e) => {
        e.stopPropagation();
        console.log(`RECORD BUTTON PRESSED for node ${node.id}`);
        toggleRecord(node.id);
    };

    div.ondblclick = (e) => {
        if (e.target.tagName !== 'INPUT') {
            e.stopPropagation();
            if (node.type === 'box') enterBox(node.id);
        }
    };

    return div;
}

// API Wrappers
export async function togglePlayback() { await callNative('toggle_playback'); }
export async function toggleRecord(id) {
    console.log(`toggleRecord called for ${id}`);
    const div = document.getElementById(id);
    if (!div) return;
    const isActive = div.querySelector('.node-btn-record').classList.contains('active');

    if (!isActive) {
        // Start recording: Clear stale peaks
        livePeaks.delete(id);
        log(`Recording started for ${id}: Cleared stale peaks.`);
    }

    log(`Toggling record for ${id} (currently ${isActive ? 'ACTIVE' : 'IDLE'})`);
    await callNative(isActive ? 'stop_recording_in_node' : 'start_recording_in_node', id);
}
export async function createNode(type) {
    creationMenu.classList.remove('active');
    await callNative('create_node', type);
}
export async function enterBox(id) {
    await callNative('enter_box', id);
    nodeLayer.innerHTML = '';
    viewport.reset();
}
export async function exitBox() {
    await callNative('exit_box');
    nodeLayer.innerHTML = '';
}
// function renameNode moved to bottom section
export async function renameNode(id, name) {
    await callNative('rename_node', id, name);
    log(`Renamed node to ${name}`);
}

export async function fetchWaveform(id) {
    if (window.isFetchingWaveform === id) return;
    window.isFetchingWaveform = id;

    try {
        log(`Fetching static waveform for ${id}...`);
        const peaks = await callNative('get_waveform', id, 200);
        if (peaks && peaks.length > 0) {
            livePeaks.set(id, peaks);
            log(`Fetched ${peaks.length} peaks for ${id}`);
        }
    } catch (err) {
        console.error("Waveform fetch failed:", err);
    } finally {
        window.isFetchingWaveform = null;
    }
}

try {
    console.log("Calling initApp()...");
    initApp();
    console.log("App Initialized. Hiding overlay.");
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
} catch (err) {
    console.error("Critical Init Error:", err);
    const status = document.getElementById('loading-status');
    if (status) status.innerHTML = `<span style="color:#ef4444">Init Failed: ${err.message}</span>`;
}

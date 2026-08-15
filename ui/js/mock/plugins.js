/**
 * mock/plugins.js — the known-plugin registry + scan mocks
 * (docs/vst3.md phase 1). Pure fixtures + a little scan phase state;
 * nothing here touches the graph.
 *
 * Shape contract: getKnownPlugins returns the same array the C++
 * PluginHostService::getKnownPluginsVar publishes (name-sorted entries
 * of {name, uid, file, maker, category, version, isInstrument});
 * getPluginScanStatus mirrors getScanStatusVar. The mock's scan is
 * DETERMINISTIC for tests: each status poll advances it one step, and
 * after kScanPolls polls it completes, having "found" one new plugin.
 */

const kScanPolls = 3;

const initialPlugins = [
    {
        name: 'Aurora Reverb', uid: 'VST3-aurora-verb',
        file: '/Library/Audio/Plug-Ins/VST3/AuroraReverb.vst3',
        maker: 'Mocksound', category: 'Fx|Reverb', version: '2.1',
        isInstrument: false,
    },
    {
        name: 'Basalt Compressor', uid: 'VST3-basalt-comp',
        file: '/Library/Audio/Plug-Ins/VST3/BasaltComp.vst3',
        maker: 'Mocksound', category: 'Fx|Dynamics', version: '1.4',
        isInstrument: false,
    },
];

const scanDiscovery = {
    name: 'Cinder Synth', uid: 'VST3-cinder-synth',
    file: '/Library/Audio/Plug-Ins/VST3/CinderSynth.vst3',
    maker: 'Mocksound', category: 'Instrument|Synth', version: '3.0',
    isInstrument: true,
};

let known = [...initialPlugins];
let scanning = false;
let pollsRemaining = 0;

/** Sorted copy, same ordering the engine publishes. */
export function getKnownPlugins() {
    return [...known].sort((a, b) =>
        a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
}

export function scanPlugins(_extraPath) {
    if (scanning) return true;
    scanning = true;
    pollsRemaining = kScanPolls;
    return true;
}

export function getPluginScanStatus() {
    if (scanning) {
        pollsRemaining -= 1;
        if (pollsRemaining <= 0) {
            scanning = false;
            if (!known.some(p => p.uid === scanDiscovery.uid)) {
                known.push(scanDiscovery);
            }
        }
    }
    return {
        scanning,
        progress: scanning ? 1 - pollsRemaining / kScanPolls : 1,
        current: scanning ? scanDiscovery.file : '',
        count: known.length,
        blacklistCount: 0,
    };
}

/** Test hook: reset the registry + scan phase to boot state. */
export function resetPlugins() {
    known = [...initialPlugins];
    scanning = false;
    pollsRemaining = 0;
}

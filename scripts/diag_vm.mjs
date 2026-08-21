#!/usr/bin/env node
/**
 * diag_vm.mjs — explain what the view-model makes of a dumped state.
 *
 *   node scripts/diag_vm.mjs [path/to/celestrian_state.json]
 *
 * (defaults to ./celestrian_state.json — the "Dump State" button writes
 * it into the app's working directory). Prints, per node: the published
 * window facts the VM reads, and per lane: the branch it took (heard /
 * edit / raw), its period, chip, brackets and bands. Run from the repo
 * root; it imports ui/js directly, no build needed.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] || resolve(root, 'celestrian_state.json');
const state = JSON.parse(readFileSync(file, 'utf8'));
const { deriveViewModel } = await import(resolve(root, 'ui/js/view_model.js'));
const { stackEffectivePeriod, calculateStackLCM } =
    await import(resolve(root, 'ui/js/timeline_model.js'));

const Q = state.quantum || 1;
const q = v => (v == null ? '—' : (v / Q).toFixed(3) + 'Q');

console.log(`state: quantum=${Q} islandEpoch=${state.islandEpoch} ` +
    `masterPos=${q(state.masterPos)} rootSeq=${JSON.stringify(state.sequence || null)}`);

function walk(n, d = 0) {
    const pad = '  '.repeat(d);
    const base = `${pad}${n.type} "${n.name}" id=${n.id}`;
    if (n.type === 'stack') {
        console.log(`${base} loop=[${q(n.loopStart)}, ${q(n.loopEnd)}) ` +
            `bypassed=${n.loopBypassed} windowActive=${n.windowActive} ` +
            `domain=${n.windowDomain} suspended=${n.windowSuspended} ` +
            `segments=${JSON.stringify(n.segments || null)} ` +
            `seq=${n.sequence ? JSON.stringify(n.sequence) : 'none'} ` +
            `isExpanded=${n.isExpanded} ` +
            `innerLCM=${q(calculateStackLCM(n.nodes, Q))} ` +
            `effective=${q(stackEffectivePeriod(n, Q))}`);
        (n.nodes || []).forEach(c => walk(c, d + 1));
    } else {
        console.log(`${base} dur=${q(n.duration)} origin=${q(n.origin)} ` +
            `loop=[${q(n.loopStart)}, ${q(n.loopEnd)}) bypassed=${n.loopBypassed} ` +
            `windowActive=${n.windowActive} rec=${n.isRecording} ` +
            `periodSource=${n.periodSource} segments=${JSON.stringify(n.segments || null)}`);
    }
}
(state.nodes || []).forEach(n => walk(n));

let vm;
try {
    vm = deriveViewModel(state);
} catch (e) {
    console.log('\nderiveViewModel THREW:\n', e.stack);
    process.exit(1);
}
console.log(`\nvm: cycleQ=${vm.cycleQ} lcmQ=${vm.lcmQ} loopCycleQ=${vm.loopCycleQ} ` +
    `playheadQ=${vm.playheadQ.toFixed(3)} qEstablished=${vm.qEstablished}`);
for (const l of vm.lanes) {
    if (l.kind !== 'clip' && l.kind !== 'group') {
        console.log(`  [${l.kind}] ${l.id}`);
        continue;
    }
    const branch = l.windowEditing ? 'EDIT' : l.windowChipQ ? 'HEARD'
        : l.underMap ? 'UNDER-MAP' : l.isQDefiner ? 'DEFINER'
        : l.recording ? 'RECORDING' : 'RAW';
    console.log(`  [${l.kind}] "${l.name}" ${branch} periodQ=${l.periodQ} ` +
        `intrinsicQ=${l.intrinsicQ} frameQ=${l.frameQ ?? '—'} ` +
        `chipQ=${l.windowChipQ ?? 0} ` +
        `window=${l.window ? `[${l.window.startQ},${l.window.endQ}) active=${l.window.active} byp=${l.window.bypassed} latent=${!!l.window.latent}` : 'null'} ` +
        `mapSegs=${JSON.stringify(l.mapSegs ?? null)} ` +
        `bandSegs=${JSON.stringify(l.bandSegs ?? null)} bandTotalQ=${l.bandTotalQ} ` +
        `bandEditable=${l.bandEditable} reps=${l.reps.length}` +
        (l.reps[0] && l.reps[0].srcSegs ? ` src0=${JSON.stringify(l.reps[0].srcSegs)}` : ''));
}

/**
 * Effects panel (docs/ui_overhaul.md effects bar; docs/vst3.md phase 2).
 *
 * A synthetic row under the lane: one card per built-in CHAIN SLOT
 * (EFFECT_SCHEMA), each a power switch + sliders, plus a "+" chip
 * whose picker (fed by the injected getKnownPlugins callback) adds a
 * VST3 plugin to the chain (docs/vst3.md phase 3). Built once from
 * EFFECT_SCHEMA; values PATCH in place, and
 * the patch keeps the DOM card order in CHAIN order (a reorder — undo,
 * load — just re-appends the cards). Bridge edits are keyed by the
 * published slot uuid (card.dataset.slot, refreshed each patch). A
 * slider being dragged is never overwritten by the 50ms tick (the
 * rename-editor lesson applied to inputs: `_hot` between pointerdown
 * and pointerup).
 */

import { ctx } from './context.js';
import { el, setText } from './sv_util.js';
import { EFFECT_SCHEMA } from '../effect_schema.js';
import {
    drawEqViz, drawCompViz, drawEchoViz, drawReverbViz,
    echoTaps, reverbTailSeconds, holdSpectrum,
} from '../fx_viz.js';

/* Scrolling compressor envelope: samples kept (one per ~50ms poll —
 * about 4.5s of history at panel scale). */
const COMP_HISTORY_LEN = 90;

/** Build the fx row once: rail label + one card per EFFECT_SCHEMA
 * entry (power, title, viz canvas, one range slider per param). */
export function buildFxRow(row, lane) {
    row.classList.add('lane-fx');
    row.dataset.depth = String(Math.min(lane.depth, 2));

    const rail = el('div', 'fx-rail mono', { textContent: 'EFFECTS' });

    const body = el('div', 'fx-body');
    EFFECT_SCHEMA.forEach(fx => {
        const card = el('div', 'fx-card');
        card.dataset.fx = fx.type;

        const head = el('div', 'fx-card-head');
        const power = el('button', 'fx-power',
            { textContent: '⏻', title: 'Enable / disable' });
        power.addEventListener('click', () => {
            const cur = chainEntry(row._lane, card.dataset.slot);
            if (!cur) return;
            ctx.cb.onSetSlotEnabled(row._lane.ownerId, cur.slot, !cur.enabled,
                fx.type);
        });
        const title = el('span', 'fx-title', { textContent: fx.label });
        head.append(power, title);
        if (fx.type === 'compressor') {
            // Live gain-reduction readout beside the title
            head.appendChild(el('span', 'fx-gr mono'));
        }
        card.appendChild(head);

        // The card's visualization (fx_viz.js): EQ spectrum+curve,
        // compressor envelope+threshold+GR, echo taps, reverb tail
        card.appendChild(el('canvas', 'fx-viz'));

        fx.params.forEach(p => {
            const line = el('label', 'fx-param');
            const name = el('span', 'fx-param-name mono',
                { textContent: p.label });
            const input = el('input', '', { type: 'range' });
            input.min = String(p.min);
            input.max = String(p.max);
            input.step = String(p.step);
            input.dataset.key = p.key;
            input.addEventListener('pointerdown', () => { input._hot = true; });
            input.addEventListener('pointerup', () => { input._hot = false; });
            input.addEventListener('input', () => {
                if (!card.dataset.slot) return;
                ctx.cb.onSetSlotParam(row._lane.ownerId, card.dataset.slot,
                    p.key, parseFloat(input.value));
                setText(line.querySelector('.fx-param-value'), p.fmt(parseFloat(input.value)));
            });
            const value = el('span', 'fx-param-value mono');
            line.append(name, input, value);
            card.appendChild(line);
        });
        body.appendChild(card);
    });

    // The add-plugin affordance (docs/vst3.md phase 3): a "+" chip at
    // the end of the body opening a picker fed by getKnownPlugins.
    const add = el('button', 'fx-add mono', {
        textContent: '＋',
        title: 'Add a VST3 plugin to this chain',
    });
    add.addEventListener('click', async (e) => {
        e.stopPropagation();
        await openPluginPicker(row, add);
    });
    body.appendChild(add);

    row.append(rail, body);
    return row;
}

/** Build + show the plugin picker under the "+" chip. One picker at a
 * time; outside click / Escape close it (the popover conventions). */
async function openPluginPicker(row, anchor) {
    closePluginPicker();
    const menu = el('div', 'fx-picker');
    menu.appendChild(el('div', 'fx-picker-head mono', { textContent: 'ADD PLUGIN' }));
    let plugins = [];
    try {
        plugins = ctx.cb.getKnownPlugins
            ? (await ctx.cb.getKnownPlugins()) || [] : [];
    } catch (err) { /* backend without plugin support: empty list */ }
    if (!plugins.length) {
        menu.appendChild(el('div', 'fx-picker-empty',
            { textContent: 'No plugins known — scan from the 🔌 Plugins panel' }));
    }
    plugins.forEach(p => {
        const item = el('button', 'fx-picker-item', {
            textContent: (p.isInstrument ? '🎹 ' : '') + p.name,
            title: p.file,
        });
        item.addEventListener('click', () => {
            ctx.cb.onAddPlugin(row._lane.ownerId, p.uid, p.name);
            closePluginPicker();
        });
        menu.appendChild(item);
    });
    anchor.parentElement.appendChild(menu);
    menu._closeOnOutside = (e) => {
        if (!menu.contains(e.target) && e.target !== anchor) closePluginPicker();
    };
    document.addEventListener('click', menu._closeOnOutside);
    activePicker = menu;
}

let activePicker = null;
function closePluginPicker() {
    if (!activePicker) return;
    document.removeEventListener('click', activePicker._closeOnOutside);
    activePicker.remove();
    activePicker = null;
}

/** Build one VST3 chip: power, name (click = open the native editor),
 * missing/latency badges, remove. Values patch in place like cards. */
function buildVst3Chip(row, body, entry) {
    const chip = el('div', 'fx-card fx-vst3');
    chip.dataset.fx = 'vst3';
    chip.dataset.slot = entry.slot;

    const head = el('div', 'fx-card-head');
    const power = el('button', 'fx-power', { textContent: '⏻', title: 'Enable / disable' });
    power.addEventListener('click', () => {
        const cur = chainEntry(row._lane, chip.dataset.slot);
        if (cur) ctx.cb.onSetSlotEnabled(row._lane.ownerId, cur.slot, !cur.enabled, cur.name);
    });
    const title = el('button', 'fx-title fx-vst3-name', {
        textContent: entry.name || 'plugin',
        title: 'Open the plugin editor',
    });
    title.addEventListener('click', () => {
        const cur = chainEntry(row._lane, chip.dataset.slot);
        if (cur && !cur.missing)
            ctx.cb.onOpenPluginEditor(row._lane.ownerId, cur.slot);
    });
    const badge = el('span', 'fx-vst3-badge mono');
    const remove = el('button', 'fx-remove', { textContent: '✕', title: 'Remove plugin' });
    remove.addEventListener('click', () => {
        ctx.cb.onRemoveChainSlot(row._lane.ownerId, chip.dataset.slot,
            entry.name);
    });
    head.append(power, title, badge, remove);
    chip.appendChild(head);
    // Insert before the "+" chip so the affordance stays last.
    const add = body.querySelector('.fx-add');
    body.insertBefore(chip, add || null);
    return chip;
}

/** The chain entry backing a card's slot uuid (null when absent). */
function chainEntry(lane, slotUuid) {
    const chain = lane && lane.effects && lane.effects.chain;
    return (chain && chain.find(s => s.slot === slotUuid)) || null;
}

/** Patch the fx row in place: card order + slot bindings follow the
 * published CHAIN; power/off classes, slider values (never over a held
 * slider — `_hot`), formatted value labels, and each card's
 * visualization redrawn per poll (~20 Hz) from the published scope
 * (spectrum / peak / GR) + the card's own parameters. */
export function patchFxRow(row, lane) {
    row._lane = lane;
    const effects = lane.effects;
    if (!effects || !Array.isArray(effects.chain)) return;
    const body = row.querySelector('.fx-body');
    if (body) {
        // Reconcile VST3 chips: create for new slots, drop stale ones.
        const chainSlots = new Set(effects.chain.map(e => e.slot));
        [...body.querySelectorAll('.fx-vst3')].forEach(chip => {
            if (!chainSlots.has(chip.dataset.slot)) chip.remove();
        });
        effects.chain.forEach(entry => {
            if (entry.type !== 'vst3') return;
            if (!body.querySelector(`.fx-card[data-slot="${entry.slot}"]`))
                buildVst3Chip(row, body, entry);
        });

        // Keep the DOM cards + chips in chain order — but only MOVE
        // nodes when the order actually changed (a 20 Hz re-append
        // would disturb an in-flight slider drag). Built-in cards bind
        // lazily by type; chips are keyed by slot uuid at creation.
        const known = effects.chain.filter(e =>
            e.type === 'vst3' || EFFECT_SCHEMA.some(f => f.type === e.type));
        const cardFor = entry =>
            body.querySelector(`.fx-card[data-slot="${entry.slot}"]`) ||
            body.querySelector(`.fx-card[data-fx="${entry.type}"]`);
        const want = known.map(e => e.slot).join();
        const have = [...body.querySelectorAll('.fx-card')]
            .map(c => c.dataset.slot).join();
        if (want !== have) {
            const add = body.querySelector('.fx-add');
            known.forEach(entry => {
                const card = cardFor(entry);
                if (card) body.insertBefore(card, add || null);
            });
        }
    }
    effects.chain.forEach(entry => {
        const state = entry;
        if (entry.type === 'vst3') {
            const chip = body &&
                body.querySelector(`.fx-card[data-slot="${entry.slot}"]`);
            if (!chip) return;
            chip.classList.toggle('off', !state.enabled);
            chip.querySelector('.fx-power').classList.toggle('on', !!state.enabled);
            setText(chip.querySelector('.fx-vst3-name'), state.name || 'plugin');
            setText(chip.querySelector('.fx-vst3-badge'),
                state.missing ? 'missing'
                    : state.latency > 0 ? state.latency + ' smp' : '');
            chip.classList.toggle('missing', !!state.missing);
            return;
        }
        const fx = EFFECT_SCHEMA.find(f => f.type === entry.type);
        if (!fx) return;  // unknown slot type
        const card = row.querySelector(`.fx-card[data-fx="${fx.type}"]`);
        if (!card) return;
        card.dataset.slot = entry.slot;
        card.classList.toggle('off', !state.enabled);
        card.querySelector('.fx-power').classList.toggle('on', !!state.enabled);
        fx.params.forEach(p => {
            const input = card.querySelector(`input[data-key="${p.key}"]`);
            const v = state[p.key];
            if (typeof v !== 'number') return;
            // Never fight the user's drag; otherwise idempotent write
            if (!input._hot && parseFloat(input.value) !== v) {
                input.value = String(v);
            }
            setText(input.parentElement.querySelector('.fx-param-value'), p.fmt(v));
        });

        // Visualization: redrawn per poll (~20 Hz) from the published
        // scope (spectrum / peak / GR) + the card's own parameters
        const viz = card.querySelector('.fx-viz');
        const scope = effects.scope || null;
        if (fx.type === 'eq') {
            // Durable line: slow-falling high-water mark of the
            // spectrum (fx_viz.js), accumulated per poll on the canvas
            viz._avgSpec = holdSpectrum(viz._avgSpec, scope && scope.spectrum);
            drawEqViz(viz, scope && scope.spectrum,
                { low: state.low, mid: state.mid, high: state.high },
                undefined, viz._avgSpec);
        } else if (fx.type === 'compressor') {
            // Scrolling envelope: accumulate the pre-rack peak per poll
            // (the live_peaks pattern, at panel scale)
            const hist = viz._hist || (viz._hist = []);
            hist.push(scope ? scope.peak || 0 : 0);
            if (hist.length > COMP_HISTORY_LEN) hist.shift();
            const gr = scope ? scope.gr || 0 : 0;
            drawCompViz(viz, hist, state.threshold, gr);
            setText(card.querySelector('.fx-gr'),
                gr > 0.05 ? '−' + gr.toFixed(1) + ' dB' : '');
        } else if (fx.type === 'echo') {
            drawEchoViz(viz, echoTaps(state), scope ? scope.peak : 0);
        } else if (fx.type === 'reverb') {
            drawReverbViz(viz, reverbTailSeconds(state), state.mix,
                scope ? scope.peak : 0);
        }
    });
}

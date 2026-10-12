/**
 * The effects panel (docs/session_view.md effects bar; docs/vst3.md): a
 * synthetic row under the lane. One card per built-in CHAIN SLOT
 * (EFFECT_SCHEMA) — a power switch, a visualization and sliders — one
 * chip per VST3 slot, and a "+" chip whose picker adds a plugin.
 *
 * The cards are built once; their values PATCH in place, and the DOM
 * keeps them in CHAIN order. Bridge edits are keyed by the published
 * slot uuid (`card.dataset.slot`, refreshed each patch). A slider is a
 * held control (context.js): while `_hot` the patch leaves it, and its
 * value label, alone.
 */

import { ctx } from './context.js';
import { el, setText, setTitle, holdControl, MAX_INDENT_DEPTH }
    from './sv_util.js';
import { openPopover, closePopover, closePopoverOf } from './popover.js';
import { EFFECT_SCHEMA } from '../effect_schema.js';
import {
    drawEqViz, drawCompViz, drawEchoViz, drawReverbViz,
    echoTaps, reverbTailSeconds, holdSpectrum,
} from '../fx_viz.js';

/* Scrolling compressor envelope: samples kept (one per ~50ms poll —
 * about 4.5s of history at panel scale). */
const COMP_HISTORY_LEN = 90;
/* The gain-reduction readout shows above this much reduction (dB). */
const GR_SHOWN_DB = 0.05;
/* The tooltip of a chip whose plugin refused the stereo layout. */
const UNSUPPORTED_TITLE = 'This plugin would not run in stereo, so it is ' +
    'bypassed: the chain plays on without it';

/** Build the fx row once: rail label, one card per EFFECT_SCHEMA entry
 * (power, title, viz canvas, one range slider per param), the "+". */
export function buildFxRow(row, lane) {
    row.classList.add('lane-fx');
    row.dataset.depth = String(Math.min(lane.depth, MAX_INDENT_DEPTH));

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
            // The range tracks the pointer itself: the hold only marks it.
            holdControl(input, { capture: false });
            const value = el('span', 'fx-param-value mono');
            input.addEventListener('input', () => {
                if (!card.dataset.slot) return;
                ctx.cb.onSetSlotParam(row._lane.ownerId, card.dataset.slot,
                    p.key, parseFloat(input.value));
                setText(value, p.fmt(parseFloat(input.value)));
            });
            line.append(name, input, value);
            card.appendChild(line);
        });
        body.appendChild(card);
    });

    const add = el('button', 'fx-add mono', {
        textContent: '＋',
        title: 'Add a VST3 plugin to this chain',
    });
    add.addEventListener('click', e => {
        e.stopPropagation();
        togglePluginPicker(row, add);
    });
    body.appendChild(add);

    row.append(rail, body);
    return row;
}

/** Open (or close) the plugin picker beside the "+" chip: the known
 * plugins (getKnownPlugins), fetched on open; a pick adds one to the
 * chain. */
async function togglePluginPicker(row, add) {
    if (closePopoverOf(add)) return;
    const menu = el('div', 'fx-picker');
    menu.appendChild(el('div', 'fx-picker-head mono', { textContent: 'ADD PLUGIN' }));
    openPopover({ menu, trigger: add, mount: add.parentElement });
    let plugins = [];
    try {
        plugins = ctx.cb.getKnownPlugins
            ? (await ctx.cb.getKnownPlugins()) || [] : [];
    } catch (err) { /* backend without plugin support: empty list */ }
    if (!menu.isConnected) return;  // closed while fetching
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
            closePopover();
        });
        menu.appendChild(item);
    });
}

/** Build one VST3 chip: power, name (click = open the native editor),
 * state/latency badge (patchVst3Chip), remove. Its values patch in
 * place like a card's. */
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
    // Before the "+" chip, which stays last.
    body.insertBefore(chip, body.querySelector('.fx-add'));
    return chip;
}

/** The chain entry backing a card's slot uuid (null when absent). */
function chainEntry(lane, slotUuid) {
    const chain = lane && lane.effects && lane.effects.chain;
    return (chain && chain.find(s => s.slot === slotUuid)) || null;
}

/** Patch the fx row in place: the cards' order and slot bindings follow
 * the published CHAIN; then each card's power state, slider values and
 * labels, and its visualization — redrawn every poll from the published
 * scope (spectrum / peak / GR) and the card's own parameters. */
export function patchFxRow(row, lane) {
    row._lane = lane;
    const effects = lane.effects;
    if (!effects || !Array.isArray(effects.chain)) return;
    const body = row.querySelector('.fx-body');
    if (body) reconcileCards(row, body, effects.chain);
    const scope = effects.scope || null;
    effects.chain.forEach(entry => {
        if (entry.type === 'vst3') {
            const chip = body &&
                body.querySelector(`.fx-card[data-slot="${entry.slot}"]`);
            if (chip) patchVst3Chip(chip, entry);
            return;
        }
        const fx = EFFECT_SCHEMA.find(f => f.type === entry.type);
        if (!fx) return;  // unknown slot type
        const card = row.querySelector(`.fx-card[data-fx="${fx.type}"]`);
        if (!card) return;
        card.dataset.slot = entry.slot;
        card.classList.toggle('off', !entry.enabled);
        card.querySelector('.fx-power').classList.toggle('on', !!entry.enabled);
        fx.params.forEach(p => {
            const input = card.querySelector(`input[data-key="${p.key}"]`);
            const v = entry[p.key];
            if (typeof v !== 'number' || input._hot) return;
            if (parseFloat(input.value) !== v) input.value = String(v);
            setText(input.parentElement.querySelector('.fx-param-value'), p.fmt(v));
        });
        drawCardViz(card, fx.type, entry, scope);
    });
}

/** Keep the chips and cards in step with `chain`: a chip per VST3 slot
 * (made for a new one, dropped with a stale one), and the DOM in chain
 * order. Nodes MOVE only when the order changed — re-appending every
 * poll would disturb a slider being dragged. Built-in cards bind to
 * their slot by type; chips are keyed by slot uuid from creation. */
function reconcileCards(row, body, chain) {
    const chainSlots = new Set(chain.map(e => e.slot));
    [...body.querySelectorAll('.fx-vst3')].forEach(chip => {
        if (!chainSlots.has(chip.dataset.slot)) chip.remove();
    });
    chain.forEach(entry => {
        if (entry.type !== 'vst3') return;
        if (!body.querySelector(`.fx-card[data-slot="${entry.slot}"]`))
            buildVst3Chip(row, body, entry);
    });
    const known = chain.filter(e =>
        e.type === 'vst3' || EFFECT_SCHEMA.some(f => f.type === e.type));
    const cardFor = entry =>
        body.querySelector(`.fx-card[data-slot="${entry.slot}"]`) ||
        body.querySelector(`.fx-card[data-fx="${entry.type}"]`);
    const want = known.map(e => e.slot).join();
    const have = [...body.querySelectorAll('.fx-card')]
        .map(c => c.dataset.slot).join();
    if (want === have) return;
    const add = body.querySelector('.fx-add');
    known.forEach(entry => {
        const card = cardFor(entry);
        if (card) body.insertBefore(card, add || null);
    });
}

/** Patch one VST3 chip. Its badge names the reason a slot in the chain
 * does not sound (docs/vst3.md §6) — `missing`: the plugin is not
 * installed here, the slot a placeholder; `unsupported`: it loaded but
 * would not run in stereo, so the engine bypasses it — else the
 * plugin's latency. */
function patchVst3Chip(chip, entry) {
    chip.classList.toggle('off', !entry.enabled);
    chip.querySelector('.fx-power').classList.toggle('on', !!entry.enabled);
    setText(chip.querySelector('.fx-vst3-name'), entry.name || 'plugin');
    const unsupported = !entry.missing && !!entry.unsupported;
    const badge = chip.querySelector('.fx-vst3-badge');
    setText(badge,
        entry.missing ? 'missing'
            : unsupported ? 'no stereo'
            : entry.latency > 0 ? entry.latency + ' smp' : '');
    setTitle(badge, unsupported ? UNSUPPORTED_TITLE : '');
    chip.classList.toggle('missing', !!entry.missing);
    chip.classList.toggle('unsupported', unsupported);
}

/** Redraw one built-in card's visualization (fx_viz.js). The canvas
 * carries what accumulates across polls: `_avgSpec`, the EQ's
 * slow-falling spectrum high-water mark, and `_hist`, the compressor's
 * scrolling pre-rack peak envelope. */
function drawCardViz(card, type, entry, scope) {
    const viz = card.querySelector('.fx-viz');
    if (type === 'eq') {
        viz._avgSpec = holdSpectrum(viz._avgSpec, scope && scope.spectrum);
        drawEqViz(viz, scope && scope.spectrum,
            { low: entry.low, mid: entry.mid, high: entry.high },
            undefined, viz._avgSpec);
    } else if (type === 'compressor') {
        const hist = viz._hist || (viz._hist = []);
        hist.push(scope ? scope.peak || 0 : 0);
        if (hist.length > COMP_HISTORY_LEN) hist.shift();
        const gr = scope ? scope.gr || 0 : 0;
        drawCompViz(viz, hist, entry.threshold, gr);
        setText(card.querySelector('.fx-gr'),
            gr > GR_SHOWN_DB ? '−' + gr.toFixed(1) + ' dB' : '');
    } else if (type === 'echo') {
        drawEchoViz(viz, echoTaps(entry), scope ? scope.peak : 0);
    } else if (type === 'reverb') {
        drawReverbViz(viz, reverbTailSeconds(entry), entry.mix,
            scope ? scope.peak : 0);
    }
}

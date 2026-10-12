/**
 * THE DIFFERENTIAL RUN: every journey (journeys.mjs) and a seeded random
 * walk (walk.mjs) driven against the real engine (CelestrianHeadless)
 * and the mock, each published state normalised and diffed (fields.mjs,
 * normalize.mjs), every diff judged against the known-drift list
 * (known_drift.mjs).
 *
 *   node ui/differential/run.mjs            the suite (npm run test:diff)
 *     --only <text>      journeys whose name contains <text>
 *     --explore          judge nothing: print every diff
 *     --emit             print unclaimed diffs as `sites` literals
 *     --verbose          print every diff, claimed or not
 *     --show             print both states after every step (show.mjs)
 *     --plain            skip the undo/redo pass
 *     --report <file>    write the drift report (markdown)
 *     --notes <json>     { familyId: text }: a line per family in the
 *                        report, titled by --note-title <word>
 *     --log <file>       also write everything printed to <file>
 *     --dump <file>      write every diff record as JSON
 *     --no-walk          skip the random walk
 *     --no-journeys      skip the journeys
 *     --seeds a,b,c      the walk's seeds          (default: walk.mjs)
 *     --walks <n>        walks per seed            (default: walk.mjs)
 *     --no-shrink        report walk findings as found, not minimised
 *
 * The engine binary: CELESTRIAN_HEADLESS, else
 * build/CelestrianHeadless_artefacts/Debug/CelestrianHeadless.
 *
 * EXIT: 0 green · 1 an unclaimed diff, a stale claim, a key-set change
 * or a harness error · 77 SKIPPED, the engine is not built.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { engineBinary, engineBinaryWanted, launchEngine } from './engine_process.mjs';

const SKIPPED = 77;

function flag(name) {
    return process.argv.includes(name);
}
function option(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
}

if (!engineBinary()) {
    process.stderr.write(
        `test:diff SKIPPED, engine not built: ${engineBinaryWanted()}\n` +
        '  build it:  cmake --build build --target CelestrianHeadless\n' +
        '  or point CELESTRIAN_HEADLESS at a built CelestrianHeadless.\n' +
        `  (exit ${SKIPPED}: nothing was compared — this is not a pass)\n`);
    process.exit(SKIPPED);
}

const { engineSide, mockSide, out: print } = await import('./sides.mjs');
const logged = [];
const out = (line = '') => {
    logged.push(line);
    print(line);
};
const finish = code => {
    if (option('--log')) writeFileSync(option('--log'), logged.join('\n') + '\n');
    process.exit(code);
};
const { Session, JourneyEnd } = await import('./session.mjs');
const { KeySets, showValue, deepEqual } = await import('./normalize.mjs');
const { Ledger, asSite } = await import('./verdict.mjs');
const { JOURNEYS, Q } = await import('./journeys.mjs');
const { KNOWN_DRIFT, KNOWN_KEYS, KNOWN_WALK } = await import('./known_drift.mjs');
const { runWalks } = await import('./walk.mjs');
const { writeReport } = await import('./report.mjs');
const { summarise } = await import('./show.mjs');

const explore = flag('--explore');
const only = option('--only');
const full = !only && !flag('--no-walk') && !flag('--no-journeys') && !flag('--plain') &&
    !option('--seeds') && !option('--walks');

const ledger = new Ledger(explore ? [] : KNOWN_DRIFT);
const keys = new KeySets();
const mock = mockSide();

// ------------------------------------------------------------ the engine

const host = { proc: null, side: null, pristine: null, launches: 0, rate: 44100 };

async function engineUp() {
    if (host.proc && host.proc.alive()) return;
    host.proc = await launchEngine();
    host.side = engineSide(host.proc);
    host.rate = (await host.proc.control('status')).rate;
    host.pristine = null;
    host.launches++;
}

function engineDown() {
    if (host.proc) host.proc.stop();
    host.proc = null;
}

/** The engine's empty state must be the one a fresh process publishes.
 * The server's reset is meant to leave exactly that; one that left
 * anything behind is caught here and the process relaunched. */
function isPristine(empty) {
    // (preQFold reads the absolute clock, which a reset does not rewind.)
    const facts = JSON.stringify([...empty.entries()]
        .filter(([k]) => k !== 'island.preQFold').map(([k, v]) => [k, v.value]));
    if (host.pristine === null) host.pristine = facts;
    return host.pristine === facts;
}

/** A session on an empty, pristine pair. */
async function openSession(options) {
    for (let attempt = 0; ; attempt++) {
        await engineUp();
        const s = new Session({ engine: host.side, mock, keys, rate: host.rate, q: Q, ...options });
        const empty = await s.begin();
        if (isPristine(empty) || attempt >= 1) {
            s.start();
            return s;
        }
        engineDown();
    }
}

// ------------------------------------------------------------ the journeys

const results = { passes: [], records: [], errors: [] };

/** One pass of one journey. `seen` — the plain pass's records, so the
 * undo pass reports only what the probes add. */
async function runPass(journey, probe, seen) {
    const name = probe ? `${journey.name} +undo` : journey.name;
    const pass = { journey: journey.name, name, probe, steps: 0, compares: 0, records: [], ended: null, error: null, trace: [] };
    const twinOf = r => seen.find(p => p.step === r.step && p.key === r.key &&
        deepEqual(p.engine, r.engine) && deepEqual(p.mock, r.mock));
    const onDiffs = records => {
        let end = false;
        for (const r of records) {
            const twin = probe ? twinOf(r) : null;
            if (twin) {
                if (twin.claim && twin.claim.claim.ends) end = true;
                continue;
            }
            r.claim = ledger.judge(r);
            pass.records.push(r);
            if (r.claim && r.claim.claim.ends) end = true;
        }
        return end ? 'end' : 'go';
    };
    let s = null;
    const onStep = flag('--show') ? ({ step, point, engine, mock: mst, differing }) => {
        const e = summarise(engine, id => s.labels.engine.get(id), Q);
        const m = summarise(mst, id => s.labels.mock.get(id), Q);
        out(`   ${point === 'block' ? '▸' : ' '} ${step}`);
        out(`        ${e === m ? 'both  ' : 'engine'} ${e}`);
        if (e !== m) out(`        mock   ${m}`);
        if (differing) out(`        (${differing} keys differ)`);
    } : null;
    try {
        s = await openSession({ journey: name, probe, onDiffs, onStep });
        await journey.run(s);
    } catch (e) {
        if (e instanceof JourneyEnd) pass.ended = e.reason;
        else {
            pass.error = String(e && e.stack || e);
            if (host.proc && !host.proc.alive()) {
                pass.error += '\n--- engine output ---\n' + host.proc.log().slice(-3000);
            }
        }
    }
    if (s) {
        pass.steps = s.steps;
        pass.compares = s.compares;
        pass.trace = s.trace;
    }
    if (pass.error) engineDown();
    return pass;
}

function printPass(pass, verbose) {
    const unknown = pass.records.filter(r => !r.claim);
    const mark = pass.error ? 'ERROR' : unknown.length ? 'DIFF ' : pass.records.length ? 'known' : 'same ';
    out(`${mark} ${pass.name.padEnd(46)} ${String(pass.steps).padStart(3)} steps ` +
        `${String(pass.compares).padStart(3)} compares  ${pass.records.length} diffs` +
        (unknown.length ? ` (${unknown.length} unclaimed)` : '') +
        (pass.ended ? `  — ended: ${pass.ended}` : ''));
    if (pass.error) out('      ' + pass.error.split('\n').join('\n      '));
    const shown = verbose ? pass.records : unknown;
    let last = null;
    for (const r of shown) {
        if (r.step !== last) out(`      [${r.step}]`);
        last = r.step;
        out(`          ${r.key}: engine ${showValue(r.engine)}  mock ${showValue(r.mock)}` +
            (r.until ? `   (until [${r.until}])` : '') +
            (r.claim ? `   <${r.claim.family.id}>` : ''));
    }
}

const started = Date.now();
if (!flag('--no-journeys')) {
    const chosen = JOURNEYS.filter(j => !only || j.name.includes(only));
    for (const journey of chosen) {
        const passes = [await runPass(journey, false, [])];
        printPass(passes[0], flag('--verbose') || explore);
        if (!flag('--plain')) {
            passes.push(await runPass(journey, true, passes[0].records));
            printPass(passes[1], flag('--verbose') || explore);
        }
        for (const p of passes) {
            results.passes.push(p);
            results.records.push(...p.records);
            if (p.error) results.errors.push(`${p.name}: ${p.error.split('\n')[0]}`);
        }
    }
}

// ---------------------------------------------------------------- the walk

let walk = null;
if (!flag('--no-walk') && !only) {
    walk = await runWalks({
        openSession, engineDown, ledger, explore,
        known: explore ? [] : KNOWN_WALK,
        seeds: option('--seeds') ? option('--seeds').split(',').map(Number) : null,
        walks: option('--walks') ? Number(option('--walks')) : null,
        shrink: !flag('--no-shrink'),
        out,
    });
}
engineDown();

// --------------------------------------------------------------- verdict

const unknown = results.records.filter(r => !r.claim);
const keyDrift = keys.compare();
const keyChanges = [];
// (A part of the suite never makes each side publish every key it can.)
if (!explore && full) {
    const kinds = new Set([...Object.keys(keyDrift), ...Object.keys(KNOWN_KEYS)]);
    for (const kind of kinds) {
        for (const which of ['engineOnly', 'mockOnly']) {
            const now = (keyDrift[kind] && keyDrift[kind][which]) || [];
            const known = (KNOWN_KEYS[kind] && KNOWN_KEYS[kind][which]) || [];
            for (const k of now) if (!known.includes(k)) keyChanges.push(`${kind}.${k}: ${which}, not in KNOWN_KEYS`);
            if (full) for (const k of known) if (!now.includes(k)) keyChanges.push(`${kind}.${k}: KNOWN_KEYS says ${which}, no longer so`);
        }
    }
}
const stale = full && !explore ? [...ledger.stale(), ...(walk ? walk.stale : [])] : [];

if (flag('--emit')) {
    out('\n--- unclaimed diffs, as sites ---');
    for (const r of unknown) out('            ' + asSite(r));
}
if (explore || flag('--verbose')) {
    out('\n--- key sets ---');
    out(JSON.stringify(keyDrift, null, 1));
}

const skipped = results.passes.filter(p => p.ended).length;
const compares = results.passes.reduce((n, p) => n + p.compares, 0);
out('');
out(`journeys: ${new Set(results.passes.map(p => p.journey)).size} (each plain and with undo/redo), ` +
    `${compares} compare points, ${results.records.length} diffs: ` +
    `${results.records.length - unknown.length} claimed by known drift, ${unknown.length} unclaimed; ` +
    `${skipped} passes ended at a known drift`);
if (walk) out(walk.summary);
out(`engine launches: ${host.launches}; ${((Date.now() - started) / 1000).toFixed(1)} s`);

if (option('--dump')) {
    writeFileSync(option('--dump'), JSON.stringify(results.records.map(r => ({
        journey: r.journey, step: r.step, verb: r.verb, key: r.key, field: r.field,
        engine: r.engine === undefined ? null : r.engine, engineAbsent: r.engine === undefined,
        mock: r.mock === undefined ? null : r.mock, mockAbsent: r.mock === undefined,
        until: r.until, family: r.claim ? r.claim.family.id : null,
    })), null, 1));
}
if (option('--report')) {
    writeFileSync(option('--report'), writeReport({
        results, walk, keyDrift, known: KNOWN_DRIFT, knownWalk: KNOWN_WALK, q: Q,
        notes: option('--notes') ? JSON.parse(readFileSync(option('--notes'), 'utf8')) : null,
        noteTitle: option('--note-title') || 'note',
    }));
    out(`report: ${option('--report')}`);
}

let failed = false;
const fail = (title, lines) => {
    if (!lines.length) return;
    failed = true;
    out(`\nFAIL — ${title}:`);
    for (const line of lines.slice(0, 60)) out('  ' + line);
    if (lines.length > 60) out(`  … and ${lines.length - 60} more`);
};
if (!explore) {
    fail('harness errors', results.errors);
    fail('diffs no known-drift entry claims (new drift, or a fixed one moved)',
        unknown.map(r => `${r.journey} [${r.step}] ${r.key}: engine ${showValue(r.engine)} mock ${showValue(r.mock)}`));
    fail('known-drift entries that claim nothing any more (delete them)',
        stale.map(c => `<${c.family.id}> ${c.kind} ${JSON.stringify(c.claim)}`));
    fail('published key sets changed', keyChanges);
    if (walk) fail('walk findings', walk.failures);
}
out(failed ? '\ntest:diff FAILED' : explore ? '\ntest:diff explored (nothing judged)' : '\ntest:diff passed');
finish(failed ? 1 : 0);

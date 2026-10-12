/**
 * The two backends behind one driver surface:
 *
 *   reset(opts)        an empty session
 *   call(verb, args)   a bridge verb → its answer
 *   advance(samples)   let the clock run
 *   state()            getGraphState
 *
 * The ENGINE side is the headless server (engine_process.mjs). The MOCK
 * side is ui/js/mock_backend.js imported into this process — a module
 * singleton, so one mock per node process.
 *
 * The mock narrates every call on console.log; it is muted here, before
 * the mock loads. The harness prints through process.stdout.
 */

import { BLOCK } from './engine_process.mjs';

const realLog = console.log;
console.log = () => {};
console.warn = () => {};
const mock = await import('../js/mock_backend.js');
const { clearTrackTemplates } = await import('../js/mock/track_templates.js');

/** Print a line (console.log stays muted for the mock's narration). */
export function out(line = '') {
    process.stdout.write(line + '\n');
}
export { realLog };

export function engineSide(proc) {
    return {
        name: 'engine',
        rootId: '',
        /** The server's reset ends every take and loads its boot
         * session: the state a fresh process publishes. */
        async reset() {
            await proc.control('reset');
            const st = await proc.call('getGraphState');
            this.rootId = st.id;
            return st;
        },
        call(verb, args) { return proc.call(verb, ...args); },
        async advance(samples) {
            if (samples > 0) await proc.control('advance', { samples });
        },
        state() { return proc.call('getGraphState'); },
    };
}

export function mockSide() {
    return {
        name: 'mock',
        rootId: 'mock-root',
        /** An empty session at `rate`, its clock at the engine's reading
         * and its transport as the engine's reset leaves it. */
        async reset({ rate, clock, playing }) {
            mock.setSampleRate(rate);
            mock.loadScenario('empty');
            clearTrackTemplates();
            mock.setMasterPos(clock);
            if (playing) await mock.callNative('togglePlayback');
            mock.pauseTransport();
            return this.state();
        },
        async call(verb, args) {
            const answer = await mock.callNative(verb, ...args);
            // The page's poll would move the clock by a tick per
            // getState while the transport runs; here only `advance`
            // moves it.
            mock.pauseTransport();
            return answer;
        },
        /** In the engine's blocks: neither side sees a coarser clock. */
        advance(samples) {
            for (let left = samples; left > 0; left -= BLOCK) {
                mock.advanceBy(Math.min(left, BLOCK));
            }
        },
        /** A read that lets no time pass: the mock's own poll is its
         * audio callback, and here only `advance` runs one. */
        state() {
            return mock.readState();
        },
    };
}

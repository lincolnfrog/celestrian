/**
 * What every verb module of the shell is handed: the bridge call, the
 * status line, and what is built from them — the verb call that owns a
 * verb's status line, and the one state read. app.js makes one and
 * injects it, so the verb modules import neither the backend nor the
 * DOM.
 *
 * THE STATUS LINE DOES NOT LIE: a verb's line is chosen from the
 * engine's ANSWER (protocol.js `returns`), never said ahead of it — and
 * the reason it gives for a refusal is read from the graph as it is
 * then (`takeLiveNow`), not from a poll that may be a take old.
 */

import { lastState, noteGraphRead, anyTakeLive } from './session_facts.js';

/** The status line when a call came back `null` — the backends' "bridge
 * unavailable / call lost" answer, which no verb gives of its own. */
export const NO_ANSWER = 'The engine did not answer — nothing changed';

/**
 * @param {object} deps
 * @param {(name: string, ...args) => Promise<*>} deps.callNative
 * @param {?() => object} deps.getState  the mock's synchronous state
 *        getter; null on a real bridge
 * @param {(msg: string) => void} deps.setLogLine  writes the status line
 */
export function createShellIo({ callNative, getState = null, setLogLine }) {
    /** Write `msg` — text, or a function of `...facts` that answers the
     * text, at once or later (a reason may need a read). Nothing is
     * written for no text: a verb with nothing true to say stays
     * silent. */
    const say = async (msg, ...facts) => {
        const text = typeof msg === 'function' ? await msg(...facts) : msg;
        if (text) setLogLine(text);
    };

    /** The line an answer earns: lost → NO_ANSWER (when the verb says
     * anything at all); refused → `failMsg`; else `okMsg`. */
    const lineFor = (result, okMsg, failMsg) => {
        if (result === null) {
            return okMsg === undefined && failMsg === undefined ? undefined : NO_ANSWER;
        }
        return failMsg !== undefined && !result ? failMsg : okMsg;
    };

    /**
     * THE VERB CALL: a user verb's bridge call and its status line in
     * one step, so no verb announces from anywhere else. Awaits
     * `method(...args)`, then says `okMsg` — or `failMsg`, when one is
     * given and the answer is falsy (refused: nothing changed), or
     * NO_ANSWER when the call was lost. Either message may be a
     * function of the answer; one that answers no text says nothing.
     * Returns the answer.
     *
     * A verb called with no `failMsg` says `okMsg` whatever the engine
     * answered: right only for a verb the engine cannot refuse
     * (protocol.js: one with no `returns`).
     */
    async function call(method, args = [], okMsg, failMsg) {
        const result = await callNative(method, ...args);
        await say(lineFor(result, okMsg, failMsg), result);
        return result;
    }

    /**
     * A verb made of several calls (`steps`: [method, ...args] each),
     * with one status line: `okMsg` after the last. With a `failMsg`,
     * THE FIRST REFUSAL ENDS THE SEQUENCE — no later step runs on a
     * graph the earlier one did not leave — and says it; a `failMsg`
     * function is handed the answer and how many steps had applied. A
     * lost call ends it too, with NO_ANSWER. Returns whether every step
     * ran.
     */
    async function callEach(steps, okMsg, failMsg) {
        let applied = 0;
        for (const [method, ...args] of steps) {
            const result = await callNative(method, ...args);
            if (failMsg !== undefined && !result) {
                await say(result === null ? NO_ANSWER : failMsg, result, applied);
                return false;
            }
            applied++;
        }
        await say(okMsg);
        return true;
    }

    /** The published graph state, now; null when the read was lost. */
    async function readState() {
        return getState ? getState() : callNative('getGraphState');
    }

    /** The state a refusal's reason is read from: the graph as it is
     * NOW, noted for the predicates of session_facts.js — or the last
     * poll's, when the read is lost. */
    async function freshState() {
        const state = await readState();
        if (!state || typeof state !== 'object') return lastState;
        noteGraphRead(state);
        return state;
    }

    /** Is a take armed or capturing now? The common reason the engine
     * refuses an edit — asked of the present graph, so the line never
     * blames a take that has ended nor misses one that just began. */
    async function takeLiveNow() {
        await freshState();
        return anyTakeLive();
    }

    return { callNative, setLogLine, call, callEach, readState, freshState,
             takeLiveNow };
}

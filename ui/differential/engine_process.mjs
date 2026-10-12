/**
 * The headless engine as a child process (src/headless/headless_main.cc):
 * the REAL engine behind `POST /call` (the bridge table) and
 * `POST /control` (the synthetic clock). The differential harness owns
 * one per run, on a port the OS hands out, with its clock PAUSED — time
 * moves only when the harness says `advance`.
 *
 * The binary comes from CELESTRIAN_HEADLESS, else the repo's build
 * directory. A missing binary is not an error here: `engineBinary()`
 * answers null and the runner reports "skipped, engine not built".
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The engine's device block: the unit its audio thread renders in. */
export const BLOCK = 512;

export const DEFAULT_BINARY = path.resolve(
    here, '../../build/CelestrianHeadless_artefacts/Debug/CelestrianHeadless');

/** The headless binary to launch, or null when it is not built. */
export function engineBinary() {
    const bin = process.env.CELESTRIAN_HEADLESS || DEFAULT_BINARY;
    return [bin, `${bin}.exe`].find(candidate => existsSync(candidate)) || null;
}

/** The path `engineBinary` looked at (for the skip message). */
export function engineBinaryWanted() {
    return process.env.CELESTRIAN_HEADLESS || DEFAULT_BINARY;
}

/** The ports other harnesses own: the mock page's server and the engine
 * e2e's. The OS never hands these out from its ephemeral range; the
 * check is a guard, not a hope. */
const RESERVED_PORTS = new Set([8080, 8091]);

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => (RESERVED_PORTS.has(port)
                ? freePort().then(resolve, reject) : resolve(port)));
        });
    });
}

// A signal ends node without its 'exit' handlers — and the child would
// outlive the run. Turn the two a terminal sends into a plain exit.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => process.exit(code));
}

function post(port, route, body) {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        // One request per connection is the server's contract
        // (Connection: close), so no agent keeps sockets.
        const req = http.request({
            host: '127.0.0.1', port, path: route, method: 'POST', agent: false,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                if (res.statusCode !== 200) {
                    reject(new Error(`${route} ${body.name || body.op}: HTTP ${res.statusCode}`));
                    return;
                }
                try { resolve(text ? JSON.parse(text) : null); }
                catch (e) { reject(new Error(`${route}: unparseable answer: ${text.slice(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

/**
 * Launch the engine. Answers { port, call, control, stop, log }:
 *   call(name, ...args)  — a bridge verb; the handler's answer (void
 *                          verbs answer undefined);
 *   control(op, params)  — status · advance{samples} · reset · input …;
 *   stop()               — kill the process and remove its scratch
 *                          projects directory;
 *   log()                — everything the process printed so far.
 * The process is also killed when node exits for any reason.
 */
export async function launchEngine({ inputs = 2, block = BLOCK } = {}) {
    const bin = engineBinary();
    if (!bin) throw new Error('engine binary missing: ' + engineBinaryWanted());
    const port = await freePort();
    const projects = mkdtempSync(path.join(os.tmpdir(), 'celestrian-diff-'));
    const lines = [];
    const child = spawn(bin, [
        '--port', String(port),
        '--ui-dir', path.resolve(here, '..'),
        '--projects-dir', projects,
        '--paused',
        // A ramp: every input sample carries its own clock, so a take
        // is never silence (and never the same twice).
        '--input', 'ramp',
        '--inputs', String(inputs),
        '--block', String(block),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = chunk => {
        lines.push(chunk.toString('utf8'));
        if (lines.length > 4000) lines.splice(0, 2000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let exited = null;
    child.on('exit', (code, signal) => { exited = { code, signal }; });

    const kill = () => {
        if (!exited) child.kill('SIGKILL');
        try { rmSync(projects, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    process.on('exit', kill);

    // Ready when the control surface answers.
    const deadline = Date.now() + 20000;
    for (;;) {
        if (exited) {
            kill();
            throw new Error(`engine exited at launch (${JSON.stringify(exited)}):\n${lines.join('')}`);
        }
        try {
            await post(port, '/control', { op: 'status' });
            break;
        } catch (e) {
            if (Date.now() > deadline) {
                kill();
                throw new Error('engine did not answer within 20 s:\n' + lines.join(''));
            }
            await new Promise(r => setTimeout(r, 40));
        }
    }

    return {
        port,
        projectsDir: projects,
        async call(name, ...args) {
            const res = await post(port, '/call', { name, args });
            return res ? res.result : undefined;
        },
        control(op, params = {}) {
            return post(port, '/control', { op, ...params });
        },
        stop() {
            process.removeListener('exit', kill);
            kill();
        },
        log() { return lines.join(''); },
        alive() { return !exited; },
    };
}

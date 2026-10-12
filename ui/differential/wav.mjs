/**
 * Audio files for the import journeys: the engine decodes a real file,
 * the mock reads the length out of the path (`#len=<samples>`, see
 * ui/js/mock/import.js). One file name serves both: a real mono 16-bit
 * WAV whose NAME carries the mock's length tag.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dir = null;

/** The scratch directory for audio files (made on first use, removed
 * when node exits). */
export function scratchDir() {
    if (!dir) {
        dir = mkdtempSync(path.join(os.tmpdir(), 'celestrian-diff-audio-'));
        process.on('exit', () => {
            try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
        });
    }
    return dir;
}

/** The path of a WAV of `samples` frames at `rate` (a quiet ramp),
 * written on first request. */
export function wavOf(samples, rate, stem = 'file') {
    const file = path.join(scratchDir(), `${stem}#len=${samples}.wav`);
    if (existsSync(file)) return file;
    const data = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) data.writeInt16LE(((i % 2000) - 1000) * 8, i * 2);
    const head = Buffer.alloc(44);
    head.write('RIFF', 0);
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVE', 8);
    head.write('fmt ', 12);
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);            // PCM
    head.writeUInt16LE(1, 22);            // mono
    head.writeUInt32LE(rate, 24);
    head.writeUInt32LE(rate * 2, 28);     // byte rate
    head.writeUInt16LE(2, 32);            // block align
    head.writeUInt16LE(16, 34);           // bits
    head.write('data', 36);
    head.writeUInt32LE(data.length, 40);
    writeFileSync(file, Buffer.concat([head, data]));
    return file;
}

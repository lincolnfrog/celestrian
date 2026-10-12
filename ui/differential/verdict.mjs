/**
 * Judging a diff against the known-drift list (known_drift.mjs).
 *
 * A diff record { journey, step, verb, key, scope, field, engine, mock }
 * is KNOWN when a family claims it, by
 *   - a SITE: this journey, this step, this key, these two values; or
 *   - an EVERYWHERE pattern: this field (and, when the pattern names
 *     them, this verb and these values) wherever it appears.
 * Sites are tried first. A claim may carry `ends: true` — the journey
 * cannot be read past this diff, so the runner stops it there.
 *
 * `Ledger` counts every claim, so a full run can name the entries that
 * claimed nothing: the list may only shrink.
 */

import { showValue } from './normalize.mjs';

const same = (a, b) => showValue(a) === showValue(b);

function siteClaims(site, r) {
    return site.journey === r.journey && site.step === r.step && site.key === r.key &&
        same(site.engine, r.engine) && same(site.mock, r.mock);
}

function patternClaims(p, r) {
    if (p.field !== r.field) return false;
    if (p.verb !== undefined && p.verb !== r.verb) return false;
    if (p.scope !== undefined && p.scope !== (r.scope.startsWith('@') || r.scope.startsWith('?') ? 'node' : r.scope)) return false;
    if ('engine' in p && !same(p.engine, r.engine)) return false;
    if ('mock' in p && !same(p.mock, r.mock)) return false;
    return true;
}

export class Ledger {
    constructor(families) {
        this.families = families;
        this.hits = new Map();   // claim object → count
    }

    /** → { family, claim, kind: 'site' | 'everywhere' } or null. */
    judge(record) {
        for (const family of this.families) {
            for (const site of family.sites || []) {
                if (siteClaims(site, record)) return this.#hit(family, site, 'site');
            }
        }
        for (const family of this.families) {
            for (const pattern of family.everywhere || []) {
                if (patternClaims(pattern, record)) return this.#hit(family, pattern, 'everywhere');
            }
        }
        return null;
    }

    #hit(family, claim, kind) {
        this.hits.set(claim, (this.hits.get(claim) || 0) + 1);
        return { family, claim, kind };
    }

    /** The claims that matched nothing: [{ family, claim, kind }]. */
    stale() {
        const out = [];
        for (const family of this.families) {
            for (const site of family.sites || []) {
                if (!this.hits.get(site)) out.push({ family, claim: site, kind: 'site' });
            }
            for (const pattern of family.everywhere || []) {
                if (!this.hits.get(pattern)) out.push({ family, claim: pattern, kind: 'everywhere' });
            }
        }
        return out;
    }
}

/** A record as the site literal that would claim it. */
export function asSite(r) {
    const v = x => (x === undefined ? 'undefined' : JSON.stringify(x));
    return `{ journey: ${JSON.stringify(r.journey)}, step: ${JSON.stringify(r.step)}, ` +
        `key: ${JSON.stringify(r.key)}, engine: ${v(r.engine)}, mock: ${v(r.mock)} },`;
}

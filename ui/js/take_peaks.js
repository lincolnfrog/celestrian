/**
 * Per-take peaks (docs/takes.md): what the take list's rows, the comp
 * cells and the silent tiles of a retaking lane draw. Cached per (clip,
 * take): a take is immutable, so an entry is good until the clip's LIST
 * changes (a commit appends, a delete renumbers — both move `takes`),
 * when every entry of that clip drops; a clip that leaves the graph
 * takes its entries with it.
 *
 * The backend answers no peaks for a clip that is armed or capturing.
 * So the one take a hot clip still draws — the take that was sounding,
 * under the new take's bar — is SEEDED from the committed peaks already
 * in hand when the retake begins, and a miss on a hot clip reads
 * nothing: asked on every patch, it would never be answered.
 */

/**
 * @param {object} deps
 * @param {(id: string, k: number) => Promise<number[]|null>} deps.fetchPeaks
 *        The backend read (getTakeWaveform). Never rejects.
 * @param {(id: string) => boolean} deps.isHot
 *        Whether the clip is armed or capturing right now.
 */
export function createTakePeakCache({ fetchPeaks, isHot }) {
    // clip id → { size, takes: Map(k → peaks), reads: Map(k → promise) }
    const lists = new Map();

    const newList = size => ({ size, takes: new Map(), reads: new Map() });

    function listOf(id) {
        let list = lists.get(id);
        if (!list) {
            list = newList(null);
            lists.set(id, list);
        }
        return list;
    }

    /** Peaks of take k, read on a miss; resolves [] on a refusal. */
    function fetch(id, k) {
        const list = listOf(id);
        if (list.takes.has(k)) return Promise.resolve(list.takes.get(k));
        if (list.reads.has(k)) return list.reads.get(k);
        const read = fetchPeaks(id, k).then(peaks => {
            list.reads.delete(k);
            if (!peaks || peaks.length === 0) return [];
            // A list replaced while the read was out renumbered its
            // takes: the answer serves its asker and is not kept.
            if (lists.get(id) === list) list.takes.set(k, peaks);
            return peaks;
        });
        list.reads.set(k, read);
        return read;
    }

    /** The cached peaks of take k, or null — the synchronous face for
     * the patch layer. A miss starts a read (the next patch draws it)
     * unless the clip is hot. */
    function now(id, k) {
        const list = lists.get(id);
        const cached = list && list.takes.get(k);
        if (cached) return cached;
        if (!isHot(id)) fetch(id, k);
        return null;
    }

    /** Hand the cache peaks already in hand for take k. */
    function seed(id, k, peaks) {
        if (peaks && peaks.length > 0) listOf(id).takes.set(k, peaks);
    }

    /** Poll hook: drop the takes of every clip whose list changed, and
     * of every clip no longer in the graph. */
    function noteNodes(nodesById) {
        for (const id of lists.keys()) {
            if (!nodesById.has(id)) lists.delete(id);
        }
        for (const n of nodesById.values()) {
            if (n.type !== 'clip') continue;
            const size = n.takes || 0;
            const list = lists.get(n.id);
            if (!list || list.size !== size) lists.set(n.id, newList(size));
        }
    }

    /** Number of clips held (tests). */
    const clipCount = () => lists.size;

    return { fetch, now, seed, noteNodes, clipCount };
}

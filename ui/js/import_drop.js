/**
 * Audio file import from the lane (docs/import.md): the pure pieces
 * of the drop gesture — whether a drag carries OS files, the drop
 * position → frame Q mapping, and the path a dropped File exposes.
 *
 * THE WEBVIEW PATH LIMIT: a File object dropped into the app's
 * WKWebView / WebView2 page carries its NAME only (a sandboxed page is
 * never handed a filesystem path). Some hosts expose a non-standard
 * `path` on the File; when it is absent the drop falls back to the
 * native chooser (importAudioWithDialog) placed at the drop's Q.
 */

/** True when a drag event carries OS files (not a lane rail drag). */
export function dragHasFiles(dataTransfer) {
    const types = dataTransfer && dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
    return false;
}

/**
 * The frame Q a drop lands on: the pointer's fraction of the lane
 * body mapped over the lane's frame cycle, rounded to the nearest
 * whole Q (Q11: imports land on Q boundaries). 0 when the frame is
 * degenerate.
 */
export function dropFrameQ(xFrac, cycleQ) {
    if (!(cycleQ > 0) || !Number.isFinite(xFrac)) return 0;
    return Math.max(0, Math.round(Math.max(0, Math.min(1, xFrac)) * cycleQ));
}

/** The filesystem path a dropped File exposes, or '' when the host
 * hands the page only the name (see the module comment). */
export function filePathOf(file) {
    if (!file) return '';
    const p = file.path;
    return typeof p === 'string' && p.length > 0 && p !== file.name ? p : '';
}

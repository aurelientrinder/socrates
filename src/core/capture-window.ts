/**
 * Live reMarkable capture (2026-11-08): choosing the window to watch. The
 * reMarkable desktop app's Screen Share is an ordinary window, so the
 * learner picks it once; Socrates remembers its title and offers it first.
 */

export interface CaptureWindow {
	id: string;
	name: string;
}

/** True for a window that looks like the reMarkable desktop app. */
export function looksLikeRemarkable(name: string): boolean {
	return /remarkable/i.test(name);
}

/**
 * The window to pre-select: the one whose title matches the remembered
 * title, else the only reMarkable-looking window, else none (the learner
 * chooses). Socrates' own window never counts.
 */
export function pickCaptureWindow<T extends CaptureWindow>(windows: readonly T[], rememberedName: string | null, ownTitle = "Socrates"): T | null {
	const others = windows.filter((w) => w.name !== ownTitle);
	if (rememberedName) {
		const remembered = others.filter((w) => w.name === rememberedName);
		if (remembered.length === 1) return remembered[0]!;
	}
	const likely = others.filter((w) => looksLikeRemarkable(w.name));
	return likely.length === 1 ? likely[0]! : null;
}

/** Likely reMarkable windows first, then the rest, each group by name. */
export function sortCaptureWindows<T extends CaptureWindow>(windows: readonly T[]): T[] {
	return [...windows].sort((a, b) => Number(looksLikeRemarkable(b.name)) - Number(looksLikeRemarkable(a.name)) || a.name.localeCompare(b.name));
}

/** A data: URL (PNG) → its raw bytes. Null for anything else. */
export function pngFromDataUrl(dataUrl: string): Uint8Array | null {
	const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
	if (!m) return null;
	const bin = atob(m[1]!);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

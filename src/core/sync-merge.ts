/**
 * LOCAL-FIRST SYNC MERGE (pure, zero-IO, browser-safe):
 * Deterministic per-domain merge between two Socrates data snapshots
 * (`Record<relativePath, text>`):
 *   - `graph/*.jsonl`: order-preserving line union (append-only ledgers never
 *     lose nodes, reasoning chains, or provenance);
 *   - `flashcards/*.json`: card-ID union + per-card review history union
 *     deduplicated by (at, grade), preserving nodeId links;
 *   - `chats/*.json`, `exams/*.json`, `cheatsheets/*.json`, `fsrs-weights.json`:
 *     newest-wins by domain timestamp (with message-count tie-break for chats);
 *   - everything else: newest-wins by per-file mtimeMs (local wins ties).
 */

import type { CardReview, Flashcard, FlashcardDeck } from "./flashcards.ts";

export interface SyncBundlePayload {
	app: "socrates";
	format: 1;
	exportedAt: string;
	deviceId: string;
	/** Relative path under data/ → UTF-8 file text. */
	files: Record<string, string>;
	/** Optional per-file mtimeMs for tie-breaking untimestamped JSON files. */
	mtimes?: Record<string, number>;
}

export interface SyncStats {
	added: number;
	updated: number;
	mergedDecks: number;
	mergedLedgers: number;
	unchanged: number;
}

export interface SyncStatus {
	configured: boolean;
	folder: string | null;
	deviceId: string;
	lastSyncedAt: string | null;
	lastStats: SyncStats | null;
}

export interface MergeResult {
	files: Record<string, string>;
	stats: SyncStats;
}

function tryJson<T>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/** Append-only JSONL union: keeps every distinct non-empty line in stable order. */
export function mergeJsonl(localText: string, remoteText: string): string {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const src of [localText, remoteText]) {
		for (const raw of src.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || seen.has(line)) continue;
			seen.add(line);
			lines.push(line);
		}
	}
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function mergeReviews(a: readonly CardReview[], b: readonly CardReview[]): CardReview[] {
	const seen = new Set<string>();
	const out: CardReview[] = [];
	for (const r of [...a, ...b]) {
		const key = `${r.at}:${r.grade}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ at: r.at, grade: r.grade });
	}
	return out.sort((x, y) => x.at - y.at || x.grade - y.grade);
}

/** Merge two FlashcardDeck JSON strings: union cards + union review histories. */
export function mergeFlashcardDecks(localText: string, remoteText: string): string | null {
	const a = tryJson<FlashcardDeck>(localText);
	const b = tryJson<FlashcardDeck>(remoteText);
	if (!a || !b || !Array.isArray(a.cards) || !Array.isArray(b.cards)) return null;

	const remoteNewer = (b.generatedAt ?? 0) > (a.generatedAt ?? 0);
	const byId = new Map<string, Flashcard>();
	for (const c of a.cards) byId.set(c.id, c);
	for (const c of b.cards) {
		const prev = byId.get(c.id);
		if (!prev) {
			byId.set(c.id, c);
			continue;
		}
		const base = remoteNewer ? c : prev;
		const other = remoteNewer ? prev : c;
		byId.set(c.id, {
			...base,
			...(base.nodeId || other.nodeId ? { nodeId: base.nodeId ?? other.nodeId } : {}),
			...(base.page !== undefined || other.page !== undefined ? { page: base.page ?? other.page } : {}),
			createdAt: Math.min(prev.createdAt, c.createdAt),
			reviews: mergeReviews(prev.reviews ?? [], c.reviews ?? []),
		});
	}

	const merged: FlashcardDeck = {
		noteId: a.noteId || b.noteId,
		noteName: remoteNewer ? b.noteName : a.noteName,
		generatedAt: Math.max(a.generatedAt ?? 0, b.generatedAt ?? 0),
		cards: [...byId.values()],
	};
	return JSON.stringify(merged, null, 2);
}

function recordStamp(raw: string): { ts: number; len: number } {
	const obj = tryJson<Record<string, unknown>>(raw);
	if (!obj || typeof obj !== "object") return { ts: 0, len: 0 };
	const parse = (v: unknown): number => {
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string") {
			const t = Date.parse(v);
			return Number.isNaN(t) ? 0 : t;
		}
		return 0;
	};
	const ts = Math.max(
		parse(obj.updatedAt),
		parse(obj.submittedAt),
		parse(obj.fittedAt),
		parse(obj.generatedAt),
		parse(obj.createdAt),
	);
	const len = Array.isArray(obj.messages) ? obj.messages.length : 0;
	return { ts, len };
}

/**
 * Deterministically merge local and remote Socrates data file maps.
 * Digests (`digests/*`) are local rebuildable caches and skipped on both sides.
 */
export function mergeSyncFiles(
	local: Readonly<Record<string, string>>,
	remote: Readonly<Record<string, string>>,
	opts: {
		localMtimes?: Readonly<Record<string, number>>;
		remoteMtimes?: Readonly<Record<string, number>>;
	} = {},
): MergeResult {
	const files: Record<string, string> = {};
	const stats: SyncStats = { added: 0, updated: 0, mergedDecks: 0, mergedLedgers: 0, unchanged: 0 };
	const allKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);

	for (const rel of [...allKeys].sort()) {
		if (rel.startsWith("digests/")) continue;
		const loc = local[rel];
		const rem = remote[rel];

		if (loc === undefined && rem !== undefined) {
			files[rel] = rem;
			stats.added++;
			continue;
		}
		if (loc !== undefined && rem === undefined) {
			files[rel] = loc;
			stats.unchanged++;
			continue;
		}
		if (loc === rem) {
			files[rel] = loc!;
			stats.unchanged++;
			continue;
		}

		// Both sides exist and differ — apply domain-specific merge.
		if (rel.startsWith("graph/") && rel.endsWith(".jsonl")) {
			const merged = mergeJsonl(loc!, rem!);
			files[rel] = merged;
			if (merged !== loc) stats.mergedLedgers++;
			else stats.unchanged++;
			continue;
		}
		if (rel.startsWith("flashcards/") && rel.endsWith(".json")) {
			const merged = mergeFlashcardDecks(loc!, rem!);
			if (merged !== null) {
				files[rel] = merged;
				if (merged !== loc) stats.mergedDecks++;
				else stats.unchanged++;
				continue;
			}
		}
		if (
			rel.startsWith("chats/") ||
			rel.startsWith("exams/") ||
			rel.startsWith("cheatsheets/") ||
			rel === "fsrs-weights.json"
		) {
			const a = recordStamp(loc!);
			const b = recordStamp(rem!);
			const pickRemote = b.ts > a.ts || (b.ts === a.ts && b.len > a.len);
			files[rel] = pickRemote ? rem! : loc!;
			if (pickRemote) stats.updated++;
			else stats.unchanged++;
			continue;
		}

		// Fallback for settings.json, briefing/*, graph/*.json: newest mtime wins.
		const lt = opts.localMtimes?.[rel] ?? 0;
		const rt = opts.remoteMtimes?.[rel] ?? 0;
		const pickRemote = rt > lt;
		files[rel] = pickRemote ? rem! : loc!;
		if (pickRemote) stats.updated++;
		else stats.unchanged++;
	}

	return { files, stats };
}

/**
 * THE READING QUEUE (2026-11-01): one list of every file the AI is reading
 * or adding to the map right now. Manual imports register here as they go
 * (the import request itself only answers at the very end); files from the
 * watched notes folder come from its own ledger. The Notes page polls it.
 */

import { notesFolderState } from "./notes-folder.ts";

export type QueueStatus = "waiting" | "reading" | "mapping" | "done" | "failed";

export interface QueueItem {
	id: string;
	name: string;
	source: "import" | "folder";
	/** The class folder, for a folder file. */
	folder?: string;
	status: QueueStatus;
	/** "Reading scanned page 3 of 12". */
	step?: string;
	error?: string;
	updatedAt: number;
}

/** A finished import stays visible this long, then drops off the list. */
const KEEP_FINISHED_MS = 10 * 60 * 1000;
const MAX_KEPT = 30;

const imports = new Map<string, QueueItem>();
let counter = 0;

function prune(now: number): void {
	for (const [id, item] of imports) {
		if ((item.status === "done" || item.status === "failed") && now - item.updatedAt > KEEP_FINISHED_MS) imports.delete(id);
	}
	while (imports.size > MAX_KEPT) imports.delete(imports.keys().next().value as string);
}

export interface QueueHandle {
	update(patch: { status?: QueueStatus; step?: string }): void;
	done(): void;
	fail(error: string): void;
}

/** Register a manual import; the handle reports its progress. */
export function trackImport(name: string, now: () => number = Date.now): QueueHandle {
	prune(now());
	const id = `imp-${++counter}`;
	const item: QueueItem = { id, name, source: "import", status: "waiting", updatedAt: now() };
	imports.set(id, item);
	const touch = (patch: Partial<QueueItem>) => {
		Object.assign(item, patch, { updatedAt: now() });
	};
	return {
		update: (patch) => touch(patch),
		done: () => touch({ status: "done", step: undefined }),
		fail: (error) => touch({ status: "failed", step: undefined, error }),
	};
}

export interface ReadingQueueState {
	items: QueueItem[];
	/** Something is waiting or running. */
	active: boolean;
}

export function readingQueueState(now: number = Date.now()): ReadingQueueState {
	prune(now);
	const items: QueueItem[] = [...imports.values()];
	const folder = notesFolderState();
	for (const f of folder.folders) {
		for (const file of f.files) {
			if (file.status !== "queued" && file.status !== "processing" && file.status !== "failed") continue;
			items.push({
				id: `fld-${f.name}/${file.key}`,
				name: file.file,
				source: "folder",
				folder: f.name,
				status: file.status === "queued" ? "waiting" : file.status === "processing" ? "reading" : "failed",
				...(file.step ? { step: file.step } : {}),
				...(file.error ? { error: file.error } : {}),
				updatedAt: 0,
			});
		}
	}
	const rank: Record<QueueStatus, number> = { reading: 0, mapping: 0, waiting: 1, failed: 2, done: 3 };
	items.sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt);
	return { items, active: items.some((i) => i.status === "waiting" || i.status === "reading" || i.status === "mapping") };
}

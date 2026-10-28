/**
 * CHAT DIGESTS: what the learning reports need from a chat, kept apart
 * from the chat file.
 *
 * Retention, weak spots, calibration, the plan and the streak used to
 * re-parse every chat transcript on every request. A digest holds the
 * derived facts of one chat (tested recalls, graded confidence answers,
 * message times) in a small file next to the data, tagged with the chat
 * file's size and mtime. A request re-derives only the chats that changed
 * since their digest was written, so the cost follows what you did today,
 * not how much you have ever studied.
 *
 * Digests also outlive the chat they came from. Deleting a session (or
 * losing a corrupt file) keeps what it proved about your memory, so the
 * schedule and the calibration view do not forget it. Digest files are
 * rebuilt from chats on demand, so deleting data/digests/ loses only the
 * history of chats that are already gone.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { calibrationAnswers, type CalibrationAnswer } from "../core/calibration.ts";
import { recallEvents, type RecallEvent } from "../core/retention.ts";
import { writeFileAtomic } from "../store/fs-atomic.ts";
import { stores } from "./stores.ts";

const DIGEST_VERSION = 1;
const CHAT_ID = /^[A-Za-z0-9_-]+$/;

export interface ChatDigest {
	version: number;
	chatId: string;
	title: string;
	/** The chat file this digest was derived from. */
	src: { mtimeMs: number; size: number };
	events: RecallEvent[];
	calibration: CalibrationAnswer[];
	/** Message times (ms), the study-time estimate's input. */
	stamps: number[];
	/** True when the chat itself no longer exists. */
	archived?: boolean;
}

function digestsDir(): string {
	return path.join(PATHS.data, "digests");
}

const MEMORY_KEY = Symbol.for("lh.chatDigests");
function memory(): Map<string, ChatDigest> {
	const g = globalThis as Record<symbol, Map<string, ChatDigest> | undefined>;
	return (g[MEMORY_KEY] ??= new Map());
}

function readDigestFile(id: string): ChatDigest | null {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(digestsDir(), `${id}.json`), "utf-8")) as Partial<ChatDigest>;
		if (raw.version !== DIGEST_VERSION || raw.chatId !== id || !raw.src || !Array.isArray(raw.events)) return null;
		return raw as ChatDigest;
	} catch {
		return null;
	}
}

function buildDigest(id: string, src: ChatDigest["src"]): ChatDigest | null {
	const record = stores.chatStore.getChat(id);
	if (!record) return null;
	return {
		version: DIGEST_VERSION,
		chatId: id,
		title: record.title,
		src,
		events: recallEvents(record),
		calibration: calibrationAnswers(record),
		stamps: record.messages.map((m) => (m as { timestamp?: number }).timestamp).filter((t): t is number => typeof t === "number" && Number.isFinite(t)),
	};
}

/** Every digest, fresh: one stat per live chat, a re-derive for each chat
 *  that changed, and the archived digests of chats that are gone. */
export function chatDigests(): ChatDigest[] {
	const mem = memory();
	const live = new Set<string>();
	const out: ChatDigest[] = [];
	let files: string[] = [];
	try {
		files = fs.readdirSync(PATHS.chats).filter((f) => f.endsWith(".json"));
	} catch {
		// no chats yet
	}
	for (const f of files) {
		const id = f.slice(0, -5);
		if (!CHAT_ID.test(id)) continue;
		live.add(id);
		let st: fs.Stats;
		try {
			st = fs.statSync(path.join(PATHS.chats, f));
		} catch {
			continue;
		}
		const src = { mtimeMs: st.mtimeMs, size: st.size };
		const fresh = (d: ChatDigest | null | undefined): d is ChatDigest => !!d && d.src.mtimeMs === src.mtimeMs && d.src.size === src.size;
		let digest: ChatDigest | null | undefined = mem.get(id);
		if (!fresh(digest)) {
			digest = readDigestFile(id);
			if (!fresh(digest)) {
				const built = buildDigest(id, src);
				// An unreadable chat (corrupt, or from a newer build) keeps the
				// digest it had rather than dropping out of every report.
				if (built) {
					fs.mkdirSync(digestsDir(), { recursive: true });
					writeFileAtomic(path.join(digestsDir(), `${id}.json`), JSON.stringify(built));
					digest = built;
				} else digest = readDigestFile(id);
			}
		}
		if (digest) {
			mem.set(id, digest);
			out.push(digest);
		}
	}
	let archived: string[] = [];
	try {
		archived = fs.readdirSync(digestsDir()).filter((f) => f.endsWith(".json"));
	} catch {
		// none yet
	}
	for (const f of archived) {
		const id = f.slice(0, -5);
		if (live.has(id) || !CHAT_ID.test(id)) continue;
		const digest = mem.get(id) ?? readDigestFile(id);
		if (!digest) continue;
		mem.set(id, digest);
		out.push({ ...digest, archived: true });
	}
	return out;
}

/** Drop a chat's digest: the learner chose to erase what the session taught. */
export function forgetChatDigest(chatId: string): void {
	if (!CHAT_ID.test(chatId)) return;
	memory().delete(chatId);
	fs.rmSync(path.join(digestsDir(), `${chatId}.json`), { force: true });
}

/** Forget every cached digest (the data folder was replaced under us). */
export function resetChatDigestCache(): void {
	memory().clear();
}

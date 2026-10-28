/**
 * THE EXAM STORE — the fs adapter for mock exams (src/core/exam.ts): one
 * JSON file per exam in data/exams/. The file holds the hidden reference
 * solutions and rubrics, so only the server ever reads it whole; the
 * browser gets examView(). Idioms: sync fs, id-guarded filenames, JSON
 * with tab indentation, write-then-rename so a crash never leaves half a
 * record.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { CURRENT_EXAM_VERSION, EXAM_ID, type ExamRecord } from "../core/exam.ts";

function examsDir(): string {
	return path.join(PATHS.data, "exams");
}

function examFile(id: string): string {
	if (!EXAM_ID.test(id)) throw new Error(`Invalid exam id: ${id}`);
	return path.join(examsDir(), `${id}.json`);
}

export function newExamId(now: number = Date.now()): string {
	return `exam_${now.toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function isExamRecord(v: unknown): v is ExamRecord {
	if (!v || typeof v !== "object") return false;
	const r = v as Partial<ExamRecord>;
	return typeof r.id === "string" && typeof r.title === "string" && typeof r.status === "string" && Array.isArray(r.problems);
}

export const examStore = {
	get(id: string): ExamRecord | null {
		if (!EXAM_ID.test(id)) return null;
		try {
			const record: unknown = JSON.parse(fs.readFileSync(examFile(id), "utf-8"));
			if (!isExamRecord(record) || record.id !== id) return null;
			// A record from a newer build is never rewritten by this one.
			if ((record.version ?? 1) > CURRENT_EXAM_VERSION) return null;
			return { ...record, answers: record.answers ?? {}, grades: record.grades ?? {}, topics: record.topics ?? [] };
		} catch {
			return null;
		}
	},

	save(record: ExamRecord): ExamRecord {
		const next = { ...record, version: CURRENT_EXAM_VERSION, updatedAt: new Date().toISOString() };
		fs.mkdirSync(examsDir(), { recursive: true });
		const file = examFile(record.id);
		const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
		fs.writeFileSync(tmp, JSON.stringify(next, null, "\t"), "utf-8");
		fs.renameSync(tmp, file);
		return next;
	},

	/** Read-modify-write one record; null when it does not exist. */
	update(id: string, change: (record: ExamRecord) => ExamRecord): ExamRecord | null {
		const record = examStore.get(id);
		return record ? examStore.save(change(record)) : null;
	},

	/** Every exam, newest first. Unreadable files are skipped. */
	list(): ExamRecord[] {
		let entries: string[];
		try {
			entries = fs.readdirSync(examsDir());
		} catch {
			return [];
		}
		const out: ExamRecord[] = [];
		for (const name of entries) {
			if (!name.endsWith(".json")) continue;
			const record = examStore.get(name.slice(0, -5));
			if (record) out.push(record);
		}
		return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	},

	remove(id: string): boolean {
		if (!examStore.get(id)) return false;
		fs.rmSync(examFile(id), { force: true });
		return true;
	},
};

export type ExamStore = typeof examStore;

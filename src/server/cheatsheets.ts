import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { notesToolFor } from "../agent/tools/notes.ts";
import { checkSheet, writeSheet } from "../agent/subagents/sheet-writer.ts";
import type { ExaminerRun } from "../agent/subagents/examiner.ts";
import {
	applySheetCheck,
	itemStanding,
	sectionsFromDraft,
	SHEET_MAX_NOTES,
	SHEET_STEPS,
	sheetSummary,
	sheetTopics,
	type SheetRecord,
	type SheetSummary,
	type SheetTopic,
} from "../core/cheatsheet.ts";
import { replyLanguageInstruction } from "../core/reply-language.ts";
import { resolveExamSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured } from "../core/settings.ts";
import { sheetStore, newSheetId } from "../store/cheatsheets.ts";
import { notesLibrary } from "../store/notes.ts";
import { retentionAcrossSessions, weakSpotsAcrossSessions } from "./chats.ts";
import { examMaterial, examTopics } from "./exams.ts";
import { providerKeyPresent } from "./keys.ts";
import { effectiveSettings, stores } from "./stores.ts";

/**
 * EXAM CHEAT SHEETS, the server side (core/cheatsheet.ts has the laws,
 * agent/subagents/sheet-writer.ts the prompts). Written in the background
 * on the mock exam model slot (it borrows Teaching when unset): notes +
 * topics with their measured standing → writer → check → ready. The page
 * polls the record's status and progress line.
 *
 * The marks are read fresh on every view: a sheet made last week shows
 * what your answers say today, so drilling a shaky line turns it known.
 */

/** Test seam: a scripted engine replaces the mock exam slot's. */
export const sheetEngineOverride: { current?: PiEngine } = {};

interface LhSheetGlobal {
	__lhSheetRuns?: Map<string, AbortController>;
}

function runs(): Map<string, AbortController> {
	const g = globalThis as typeof globalThis & LhSheetGlobal;
	return (g.__lhSheetRuns ??= new Map());
}

export class SheetError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body?: unknown,
	) {
		super(message);
	}
}

function writerRun(signal: AbortSignal): ExaminerRun {
	if (sheetEngineOverride.current) return { engine: sheetEngineOverride.current, signal };
	const spec = resolveExamSpec(stores.settingsStore.readSettings());
	if (!spec) throw new SheetError("Choose a model first (Settings, Models).", 503, modelsNotConfigured(["strong"]));
	if (!providerKeyPresent(spec.provider)) throw new SheetError(`The ${spec.provider} key is missing (Settings, Keys).`, 503);
	return {
		engine: piEngineForSpec(spec),
		signal,
		languageLine: replyLanguageInstruction(effectiveSettings().agent.replyLanguage),
	};
}

/** The offered topics with what the learner's answers say about them now. */
function measuredTopics(topics: readonly { key: string; title: string; summary?: string }[], now: number): SheetTopic[] {
	return sheetTopics(topics, retentionAcrossSessions(now).topics, weakSpotsAcrossSessions(now).spots);
}

/** A record with its marks re-read from today's answers. */
export function refreshStanding(record: SheetRecord, now: number = Date.now()): SheetRecord {
	if (record.status !== "ready" || record.topics.length === 0) return record;
	const topics = measuredTopics(record.topics, now);
	const byKey = new Map(topics.map((t) => [t.key, t]));
	return {
		...record,
		topics,
		sections: record.sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, ...itemStanding(i.topicKeys, byKey) })) })),
	};
}

function cleanText(v: unknown, max: number): string {
	return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function startSheet(input: { scope?: unknown; focus?: unknown; noteIds?: unknown }): { id: string } {
	const scope = cleanText(input.scope, 2000);
	const focus = cleanText(input.focus, 2000);
	const noteIds = Array.isArray(input.noteIds)
		? [...new Set(input.noteIds.filter((id): id is string => typeof id === "string" && notesLibrary.get(id) !== null))].slice(0, SHEET_MAX_NOTES)
		: [];
	if (!scope && noteIds.length === 0) throw new SheetError("Say which exam it is for, or pick notes to write it from.", 400);
	writerRun(new AbortController().signal); // refuse before anything is written
	const now = new Date();
	const record: SheetRecord = {
		id: newSheetId(now.getTime()),
		title: scope ? `Cheat sheet: ${scope.split("\n")[0]!.slice(0, 60)}` : "Cheat sheet",
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		scope: { text: scope, focus, noteIds },
		status: "generating",
		phase: "Reading your notes",
		topics: [],
		sections: [],
	};
	sheetStore.save(record);
	void generate(record.id);
	return { id: record.id };
}

async function generate(id: string): Promise<void> {
	if (runs().has(id)) return;
	const controller = new AbortController();
	runs().set(id, controller);
	const phase = (text: string) => sheetStore.update(id, (r) => ({ ...r, phase: text }));
	try {
		const record = sheetStore.get(id);
		if (!record) return;
		const run = writerRun(controller.signal);
		const { text, focus, noteIds } = record.scope;
		const topics = measuredTopics(examTopics(`${text}\n${focus}`, noteIds), Date.now());
		const material = examMaterial(noteIds);
		phase(SHEET_STEPS[0]);
		const { draft, figures } = await writeSheet(run, {
			scope: text,
			focus,
			material,
			topics,
			...(notesLibrary.list().length > 0 ? { notesTool: notesToolFor(notesLibrary) } : {}),
		});
		const written = sectionsFromDraft(draft, topics, figures);
		phase(SHEET_STEPS[1]);
		const verdicts = await checkSheet(run, { sections: written, material, focus });
		const checked = applySheetCheck(written, verdicts);
		if (checked.sections.length === 0) throw new Error("No line of the sheet held up under the check. Try again, or narrow what it covers.");
		const items = written.reduce((n, s) => n + s.items.length, 0);
		sheetStore.update(id, (r) => ({
			...r,
			title: draft.title.trim() || r.title,
			topics,
			sections: checked.sections,
			checks: { items, fixed: checked.fixed, dropped: checked.dropped },
			status: "ready",
			phase: undefined,
			error: undefined,
		}));
	} catch (err) {
		if (controller.signal.aborted && !sheetStore.get(id)) return; // deleted mid-run
		const message = err instanceof Error ? err.message : String(err);
		console.info(`[sheet ${id}] generation failed: ${message}`);
		sheetStore.update(id, (r) => ({ ...r, status: "failed", phase: undefined, error: message }));
	} finally {
		runs().delete(id);
	}
}

/** The sheet as the page sees it; a run that died with the process is
 *  marked failed (retryable). */
export function getSheet(id: string, now: number = Date.now()): SheetRecord | null {
	let record = sheetStore.get(id);
	if (!record) return null;
	if (record.status === "generating" && !runs().has(id)) {
		record = sheetStore.save({ ...record, status: "failed", phase: undefined, error: "Writing the sheet was interrupted." });
	}
	return refreshStanding(record, now);
}

export function retrySheet(id: string): SheetRecord {
	const record = sheetStore.get(id);
	if (!record) throw new SheetError("Cheat sheet not found.", 404);
	if (record.status !== "failed") throw new SheetError("Nothing to retry.", 409);
	writerRun(new AbortController().signal);
	sheetStore.save({ ...record, status: "generating", phase: "Reading your notes", error: undefined, sections: [] });
	void generate(id);
	return getSheet(id)!;
}

export function listSheets(now: number = Date.now()): SheetSummary[] {
	return sheetStore.list().map((r) => sheetSummary(refreshStanding(r, now)));
}

export function deleteSheet(id: string): boolean {
	const removed = sheetStore.remove(id);
	runs().get(id)?.abort();
	return removed;
}

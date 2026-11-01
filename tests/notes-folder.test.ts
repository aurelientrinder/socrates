/**
 * The watched notes folder (src/core/notes-folder.ts rules, src/server/
 * notes-folder.ts service): a folder with one subfolder per class, every page
 * read ONCE. Handwritten PDFs here are hand-built: pages of pen strokes (path
 * operators, no text layer), like a reMarkable export. The model calls are
 * faked and counted: the point of these tests is what is NOT called.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { pagePlan, processedPathFor, recordKeyFor } from "../src/core/notes-folder.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-folder-"));
process.env.LH_DATA_DIR = TMP_DATA;
delete process.env.GEMINI_API_KEY;
const folder = await import("../src/server/notes-folder.ts");
const courses = await import("../src/server/courses.ts");
const { notesLibrary } = await import("../src/store/notes.ts");
const { pdfPagePrints, textPagePrints } = await import("../src/server/page-prints.ts");
after(() => {
	folder.resetNotesFolderForTests();
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

// ─── A tiny handwritten-PDF maker ───────────────────────────────────────────

/** One page of "pen strokes": a few wavy lines, different per seed. */
function strokes(seed: number): string {
	let r = seed * 7919 + 1;
	const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
	const lines: string[] = ["1 w 0 0 0 RG"];
	for (let l = 0; l < 6; l++) {
		const y = 700 - l * 60;
		let d = `40 ${y} m`;
		for (let x = 40; x < 560; x += 20) d += ` ${x + 10} ${(y + (rnd() - 0.5) * 30).toFixed(1)} ${x + 20} ${(y + (rnd() - 0.5) * 8).toFixed(1)} ${x + 20} ${y} c`;
		lines.push(`${d} S`);
	}
	return lines.join("\n");
}

/** A PDF whose pages are the given content streams. `stamp` changes file-level metadata only. */
function makePdf(pages: string[], stamp = "1"): Buffer {
	const objs: string[] = [];
	const n = pages.length;
	objs.push("<< /Type /Catalog /Pages 2 0 R >>");
	objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${n} >>`);
	pages.forEach((content, i) => {
		objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << >> >>`);
		objs.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
	});
	objs.push(`<< /Producer (test ${stamp}) /CreationDate (D:2026110${stamp}) >>`);
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(Buffer.byteLength(out));
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = Buffer.byteLength(out);
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

const notebook = (seeds: number[], stamp = "1") => makePdf(seeds.map(strokes), stamp);

// ─── Fakes ──────────────────────────────────────────────────────────────────

let read: number[][] = [];
let imported: { filePath: string; text: string }[] = [];
let failRead: Error | null = null;
let failImport: Error | null = null;
const NOW = Date.now() + 60_000;

function useFakes() {
	read = [];
	imported = [];
	failRead = null;
	failImport = null;
	folder.setNotesFolderDeps({
		now: () => NOW,
		sleep: async () => {},
		renderPages: async (_p, pages) => pages.map((page) => ({ page, png: new Uint8Array([page]) })),
		readPages: async (images) => {
			if (failRead) throw failRead;
			read.push(images.map((i) => i.page));
			return new Map(images.map((i) => [i.page, `handwriting of page ${i.page}`]));
		},
		importNotes: async (input) => {
			if (failImport) throw failImport;
			imported.push(input);
			return { nodes: 1, chains: 0 };
		},
	});
}

let ROOT = "";
function freshRoot() {
	ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "lh-watched-"));
	for (const sub of ["Analyse", "Physique", "Perso"]) fs.mkdirSync(path.join(ROOT, sub));
}
const put = (rel: string, bytes: Buffer | string) => {
	fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
	fs.writeFileSync(path.join(ROOT, rel), bytes);
};
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
const files = () => folder.notesFolderState().folders.flatMap((f) => f.files);
const file = (key: string) => files().find((f) => f.key === key);

async function setUp(choices: Record<string, { include: boolean; watch: boolean; mode?: string }>) {
	const analyse = courses.createCourse({ label: "Analyse" }).key;
	const all: Record<string, import("../src/server/notes-folder.ts").FolderChoice> = {};
	for (const [name, c] of Object.entries(choices)) all[name] = { course: name === "Analyse" ? analyse : { new: name }, ...c };
	await folder.setUpFolder({ root: ROOT, folders: all });
	await folder.notesFolderSettled();
}

async function rescan() {
	await folder.scanNotesFolder();
	await folder.notesFolderSettled();
}

beforeEach(() => {
	folder.stopWatching();
	folder.resetNotesFolderForTests();
	fs.rmSync(path.join(TMP_DATA, "notes-folder"), { recursive: true, force: true });
	freshRoot();
	useFakes();
});

// ─── Pure rules ─────────────────────────────────────────────────────────────

describe("pagePlan", () => {
	it("splits unread pages into new (past the processed length) and edited (in place)", () => {
		const known = new Set(["a", "b", "c"]);
		assert.deepEqual(pagePlan(["a", "b", "c", "d", "e"], known, 3), { newPages: [4, 5], editedPages: [] });
		assert.deepEqual(pagePlan(["a", "X", "c", "d"], known, 3), { newPages: [4], editedPages: [2] });
		assert.deepEqual(pagePlan(["a", "b"], known, 0), { newPages: [], editedPages: [] });
	});
	it("reads a page repeated inside a file once (blank template pages)", () => {
		assert.deepEqual(pagePlan(["z", "z", "z"], new Set(), 0), { newPages: [1], editedPages: [] });
	});
	it("keys a file the same inside and outside Processed", () => {
		assert.equal(recordKeyFor("Analyse/Processed/Ch 1.pdf"), "Analyse/Ch 1.pdf");
		assert.equal(recordKeyFor("Processed/loose.pdf"), "loose.pdf");
		assert.equal(processedPathFor("Analyse/sub/Ch 1.pdf"), "Analyse/Processed/sub/Ch 1.pdf");
		assert.equal(processedPathFor("loose.pdf"), "Processed/loose.pdf");
	});
});

describe("page fingerprints", () => {
	it("match for the same page in another export, another position, another file", async () => {
		const a = await pdfPagePrints(notebook([1, 2, 3], "1"));
		const b = await pdfPagePrints(notebook([9, 1, 2, 3], "2"));
		assert.deepEqual(b.slice(1).map((p) => p.fp), a.map((p) => p.fp));
		assert.notEqual(b[0]!.fp, a[0]!.fp);
		assert.ok(a.every((p) => p.needsVision), "pen strokes with no text layer need eyes");
	});
	it("split text files into paragraphs", () => {
		assert.equal(textPagePrints("one\n\ntwo\n\n\nthree").length, 3);
	});
});

// ─── The service ────────────────────────────────────────────────────────────

describe("set-up", () => {
	it("lists the subfolders with a class matched by name", async () => {
		courses.createCourse({ label: "Physique" });
		put("Analyse/ch1.pdf", notebook([1]));
		const preview = folder.previewFolder(ROOT);
		assert.deepEqual(preview.folders.map((f) => f.name), ["Analyse", "Perso", "Physique"]);
		assert.equal(preview.folders.find((f) => f.name === "Physique")!.courseLabel, "Physique");
		assert.equal(preview.folders.find((f) => f.name === "Analyse")!.files, 1);
	});

	it("lists existing files without spending anything (one by one is the default)", async () => {
		put("Analyse/ch1.pdf", notebook([1, 2]));
		await setUp({ Analyse: { include: true, watch: true } });
		assert.equal(file("Analyse/ch1.pdf")!.status, "waiting");
		assert.equal(read.length + imported.length, 0);
	});

	it("excludes a folder with both switches off, and skips older files when include is off", async () => {
		put("Perso/diary.pdf", notebook([5]));
		put("Physique/old.pdf", notebook([6]));
		await setUp({ Perso: { include: false, watch: false }, Physique: { include: false, watch: true } });
		assert.equal(folder.notesFolderState().folders.some((f) => f.name === "Perso"), false);
		assert.equal(file("Physique/old.pdf")!.status, "skipped");
		put("Physique/new.pdf", notebook([7]));
		await rescan();
		assert.equal(file("Physique/new.pdf")!.status, "waiting");
		assert.equal(folder.notesFolderState().pending.length, 1, "Analyse was not set up: it is asked about");
	});
});

describe("processing", () => {
	it("reads every page once, adds it to the map, files it in the class and moves it to Processed", async () => {
		put("Analyse/ch1.pdf", notebook([1, 2, 3, 4, 5]));
		await setUp({ Analyse: { include: true, watch: true } });
		await folder.requestProcessing({ keys: ["Analyse/ch1.pdf"] });
		await folder.notesFolderSettled();
		assert.deepEqual(read, [[1, 2, 3, 4], [5]]);
		assert.equal(imported.length, 1);
		assert.match(imported[0]!.text, /--- Page 5 ---\nhandwriting of page 5/);
		assert.equal(imported[0]!.filePath, "Analyse › ch1.pdf");
		assert.equal(file("Analyse/ch1.pdf")!.status, "processed");
		assert.ok(exists("Analyse/Processed/ch1.pdf") && !exists("Analyse/ch1.pdf"));
		const note = notesLibrary.list().find((n) => n.name === "Analyse › ch1.pdf")!;
		assert.ok(courses.readCourseLinks()["analyse"]!.noteIds!.includes(note.id));
	});

	it("never reads a renamed copy or a file moved back out of Processed", async () => {
		put("Analyse/ch1.pdf", notebook([1, 2]));
		await setUp({ Analyse: { include: true, watch: true, mode: "auto" } });
		await folder.notesFolderSettled();
		assert.equal(imported.length, 1);
		put("Analyse/copy of ch1.pdf", notebook([1, 2], "7"));
		fs.renameSync(path.join(ROOT, "Analyse/Processed/ch1.pdf"), path.join(ROOT, "Analyse/ch1.pdf"));
		await rescan();
		assert.equal(imported.length, 1);
		assert.equal(read.flat().length, 2);
		assert.equal(file("Analyse/copy of ch1.pdf")!.status, "processed");
		assert.ok(exists("Analyse/Processed/copy of ch1.pdf") && exists("Analyse/Processed/ch1.pdf"));
	});

	it("reads only the new pages of a re-exported notebook", async () => {
		put("Analyse/ch1.pdf", notebook([1, 2, 3]));
		await setUp({ Analyse: { include: true, watch: true } });
		await folder.requestProcessing({ folder: "Analyse", all: true });
		await folder.notesFolderSettled();
		read = [];
		imported = [];
		put("Analyse/ch1.pdf", notebook([1, 2, 3, 4, 5], "2"));
		await rescan();
		const v = file("Analyse/ch1.pdf")!;
		assert.equal(v.status, "waiting");
		assert.equal(v.newPages, 2);
		assert.equal(v.update, true);
		await folder.requestProcessing({ keys: ["Analyse/ch1.pdf"] });
		await folder.notesFolderSettled();
		assert.deepEqual(read, [[4, 5]]);
		assert.equal(imported.length, 1);
		assert.doesNotMatch(imported[0]!.text, /Page [123] /);
		assert.match(imported[0]!.text, /--- Page 4 ---/);
		// The Library keeps the whole notebook's text.
		const note = notesLibrary.list().find((n) => n.name === "Analyse › ch1.pdf")!;
		assert.match(notesLibrary.text(note.id)!, /Page 1 ---\nhandwriting of page 1[\s\S]*Page 5 ---\nhandwriting of page 5/);
		assert.ok(exists("Analyse/Processed/ch1.pdf") && !exists("Analyse/ch1.pdf"));
	});

	it("flags an edited page instead of reading it, and keeping it as is files the notebook", async () => {
		put("Analyse/ch1.pdf", notebook([1, 2, 3]));
		await setUp({ Analyse: { include: true, watch: true, mode: "auto" } });
		await folder.notesFolderSettled();
		read = [];
		put("Analyse/ch1.pdf", notebook([1, 22, 3], "3"));
		await rescan();
		const v = file("Analyse/ch1.pdf")!;
		assert.equal(v.status, "processed");
		assert.equal(v.editedPages, 1);
		assert.equal(read.length, 0, "automatic mode does not read edits");
		assert.ok(exists("Analyse/ch1.pdf"), "a file with unread edits stays out of Processed");
		await folder.keepEdits("Analyse/ch1.pdf");
		assert.equal(file("Analyse/ch1.pdf")!.editedPages, 0);
		assert.ok(exists("Analyse/Processed/ch1.pdf"));
		assert.equal(read.length, 0);
	});

	it("reads edited pages when asked, and only those", async () => {
		put("Analyse/ch1.pdf", notebook([1, 2, 3]));
		await setUp({ Analyse: { include: true, watch: true, mode: "auto" } });
		await folder.notesFolderSettled();
		read = [];
		put("Analyse/ch1.pdf", notebook([1, 22, 3, 4], "3"));
		await rescan();
		await folder.notesFolderSettled();
		assert.deepEqual(read, [[4]], "automatic mode read the new page only");
		await folder.requestProcessing({ keys: ["Analyse/ch1.pdf"], edited: true });
		await folder.notesFolderSettled();
		assert.deepEqual(read, [[4], [2]]);
		assert.equal(file("Analyse/ch1.pdf")!.editedPages, 0);
	});

	it("automatic mode picks up a new file and never retries a failure by itself", async () => {
		await setUp({ Analyse: { include: true, watch: true, mode: "auto" } });
		failRead = new Error("Gemini handwriting reading API 500: boom");
		put("Analyse/ch2.pdf", notebook([8, 9]));
		await rescan();
		assert.equal(file("Analyse/ch2.pdf")!.status, "failed");
		failRead = null;
		await rescan();
		put("Analyse/other.pdf", notebook([10]));
		await rescan();
		assert.equal(file("Analyse/ch2.pdf")!.status, "failed", "still waiting for Retry");
		assert.equal(file("Analyse/other.pdf")!.status, "processed");
		await folder.requestProcessing({ keys: ["Analyse/ch2.pdf"], retry: true });
		await folder.notesFolderSettled();
		assert.equal(file("Analyse/ch2.pdf")!.status, "processed");
	});

	it("a retry after a map failure does not read the handwriting again", async () => {
		put("Analyse/ch1.pdf", notebook([1, 2]));
		await setUp({ Analyse: { include: true, watch: true } });
		failImport = new Error("provider down");
		await folder.requestProcessing({ keys: ["Analyse/ch1.pdf"] });
		await folder.notesFolderSettled();
		assert.equal(file("Analyse/ch1.pdf")!.status, "failed");
		assert.deepEqual(read, [[1, 2]]);
		failImport = null;
		await folder.requestProcessing({ keys: ["Analyse/ch1.pdf"], retry: true });
		await folder.notesFolderSettled();
		assert.deepEqual(read, [[1, 2]], "pages read before are not paid for again");
		assert.equal(imported.length, 1);
		assert.equal(file("Analyse/ch1.pdf")!.status, "processed");
	});

	it("a used-up daily limit pauses the queue and puts the file back on the list", async () => {
		const { HandwritingRequestError } = await import("../src/server/handwriting.ts");
		await setUp({ Analyse: { include: true, watch: true, mode: "auto" } });
		failRead = new HandwritingRequestError("Gemini handwriting reading quota reached (free-tier limits reset daily): Quota exceeded for metric generate_requests_per_model_per_day, GenerateRequestsPerDayPerProjectPerModel", 429);
		put("Analyse/a.pdf", notebook([31]));
		await rescan();
		const s = folder.notesFolderState();
		assert.ok(s.paused);
		assert.equal(file("Analyse/a.pdf")!.status, "waiting");
		failRead = null;
		await rescan();
		assert.equal(file("Analyse/a.pdf")!.status, "waiting", "nothing starts while paused");
		folder.resumeNotesFolder();
		await folder.notesFolderSettled();
		assert.equal(file("Analyse/a.pdf")!.status, "processed");
	});

	it("a run cut short comes back as failed, never restarted on its own", async () => {
		put("Analyse/ch1.pdf", notebook([1]));
		await setUp({ Analyse: { include: true, watch: true, mode: "auto" } });
		await folder.notesFolderSettled();
		const ledgerFile = path.join(TMP_DATA, "notes-folder", "ledger.json");
		const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf-8"));
		const rec = ledger.roots[ROOT]["Analyse/ch1.pdf"];
		ledger.roots[ROOT]["Analyse/ch2.pdf"] = { ...rec, key: "Analyse/ch2.pdf", at: "Analyse/ch2.pdf", status: "processing", pages: ["p_unread"], baselinePages: 0 };
		fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
		put("Analyse/ch2.pdf", notebook([1]));
		const before = imported.length;
		folder.resetNotesFolderForTests();
		folder.ensureNotesFolder();
		await new Promise((r) => setTimeout(r, 30));
		await folder.notesFolderSettled();
		const v = folder.notesFolderState().folders[0]!.files.find((f) => f.key === "Analyse/ch2.pdf");
		assert.equal(v?.status, "failed");
		assert.match(v!.error!, /Retry/);
		assert.equal(imported.length, before);
	});
});

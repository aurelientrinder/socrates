/**
 * Course groups (src/core/courses.ts, src/server/courses.ts): calendar
 * classes are suggested as groups by plain rules (fake events here — the
 * Google sign-in is not needed), a group's notes feed the briefing and the
 * study plan, and the server keeps groups, aliases and dismissals on disk
 * under an isolated LH_DATA_DIR (set before any app-module import).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { folderNoteName, isNotesFile, suggestCourses } from "../src/core/courses.ts";
import { classifyEvent, courseGroupFor, courseOf, foldSessionKeys, planBriefing, sessionTypeOf, startPrompt, topicsForEvent, type StudyEvent } from "../src/core/briefing.ts";
import type { TopicRetention } from "../src/core/retention.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-courses-"));
process.env.LH_DATA_DIR = TMP_DATA;
const { notesLibrary } = await import("../src/store/notes.ts");
const courses = await import("../src/server/courses.ts");
after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// A Monday, 09:00 local.
const NOW = new Date(2026, 9, 26, 9, 0, 0).getTime();

let n = 0;
function ev(title: string, daysAhead: number, over: Partial<StudyEvent> = {}): StudyEvent {
	const start = NOW + daysAhead * DAY + HOUR;
	return { id: `e${n++}`, title, start, end: start + 2 * HOUR, allDay: false, source: "calendar", ...over };
}

/** Five weeks of a made-up timetable. */
function timetable(): StudyEvent[] {
	const out: StudyEvent[] = [];
	for (let w = 0; w < 5; w++) {
		out.push(ev("CM Analyse 2", w * 7 + 1), ev("TD Analyse 2", w * 7 + 3));
		out.push(ev("Thermodynamique - cours", w * 7 + 2));
		out.push(ev("Gym", w * 7 + 2), ev("Déjeuner avec Paul", w * 7 + 4));
	}
	out.push(ev("Partiel Thermodynamique", 20));
	out.push(ev("MATH201 Lecture 3", 4), ev("MATH201 Lecture 4", 11));
	out.push(ev("Dentiste", 5), ev("Fête de Léa", 6, { allDay: true }));
	return out;
}

describe("suggestCourses", () => {
	const got = suggestCourses(timetable(), {}, [], NOW);
	const keys = got.map((s) => s.key);

	it("makes one suggestion per class, joining CM and TD of the same course", () => {
		assert.ok(keys.includes("analyse"));
		assert.equal(got.filter((s) => s.key === "analyse").length, 1);
		assert.equal(got.find((s) => s.key === "analyse")!.classes, 10);
		assert.ok(keys.includes("thermodynamique"));
		assert.equal(got.find((s) => s.key === "thermodynamique")!.exams, 1);
	});

	it("reads course codes and ignores things that are not classes", () => {
		assert.ok(keys.includes("math201"));
		for (const bad of ["gym", "déjeuner avec paul", "dentiste", "fête de léa"]) assert.ok(!keys.includes(bad), bad);
	});

	it("needs more than one lone class event", () => {
		assert.deepEqual(suggestCourses([ev("Guest lecture on rockets", 2)], {}, [], NOW), []);
	});

	it("leaves out groups that exist (also by alias) and suggestions that were dismissed", () => {
		const groups = { "analyse": { label: "Analyse" }, mine: { label: "Physics", aliases: ["math201"] } };
		const left = suggestCourses(timetable(), groups, ["thermodynamique"], NOW).map((s) => s.key);
		assert.ok(!left.includes("analyse") && !left.includes("math201") && !left.includes("thermodynamique"));
	});

	it("never suggests from to-do tasks or deadlines", () => {
		const todo = [ev("Analyse 2 homework", 3, { source: "todo" }), ev("Analyse 2 homework", 5, { source: "todo" }), ev("Analyse 2 homework due", 6)];
		assert.deepEqual(suggestCourses(todo, {}, [], NOW), []);
	});
});

describe("a course's notes in the plan", () => {
	const topic = (key: string, title: string, chatId: string): TopicRetention => ({
		key, kind: "proposition", title, chatId, chatTitle: "Notes", answers: 3, reviews: 2, lapses: 0, lastReviewedAt: NOW - DAY,
		lastGrade: 3, stability: 4, difficulty: 5, retention: 0.8, dueAt: NOW + DAY, due: false,
	});
	const links = { "analyse": { label: "Analyse", noteIds: ["src_aaaaaaaaaaaa"], aliases: ["math201"] } };
	const material = { "analyse": { notes: [{ id: "src_aaaaaaaaaaaa", name: "Analyse › Ch1.pdf" }], topicKeys: ["prop:limit"] } };

	it("matches an event to its group by key or alias and adopts the group's label", () => {
		assert.equal(courseGroupFor(links, "math201")!.key, "analyse");
		const m = topicsForEvent(ev("CM Analyse 2", 1), [topic("prop:limit", "Limits", "x")], links, [], material);
		assert.equal(m.course.label, "Analyse");
		assert.deepEqual(m.topics.map((t) => t.key), ["prop:limit"]);
		assert.deepEqual(m.notes.map((x) => x.name), ["Analyse › Ch1.pdf"]);
	});

	it("counts topics learned from the notes toward an exam and names the files in the session prompt", () => {
		const plan = planBriefing({
			now: NOW,
			events: [ev("Partiel Analyse 2", 9)],
			topics: [topic("prop:limit", "Limits", "x")],
			sessions: [],
			links,
			material,
			confidentMissChats: new Set(),
		});
		assert.equal(plan.upcoming[0]!.topicCount, 1);
		assert.equal(plan.upcoming[0]!.noteCount, 1);
		const item = plan.study!.days.flatMap((d) => d.items).find((i) => i.noteNames);
		assert.ok(item, "an item carries the course files");
		assert.match(startPrompt(item!), /"Analyse › Ch1\.pdf"/);
	});

	it("tells the tutor about the files when nothing is studied yet", () => {
		const plan = planBriefing({
			now: NOW,
			events: [ev("Partiel Analyse 2", 9)],
			topics: [],
			sessions: [],
			links,
			material,
			confidentMissChats: new Set(),
		});
		const learn = plan.items.find((i) => i.action === "learn")!;
		assert.deepEqual(learn.noteNames, ["Analyse › Ch1.pdf"]);
		assert.match(startPrompt(learn), /course notes/);
	});
});

describe("CM, TD and TP are one course", () => {
	const same: [string, string][] = [
		["CM Analyse", "lecture"], ["TD Analyse", "tutorial"], ["TP Analyse", "lab"],
		["TD1 Analyse", "tutorial"], ["TD 2 - Analyse", "tutorial"], ["TP-3 Analyse", "lab"], ["TD2A Analyse G2", "tutorial"],
		["Analyse (TD)", "tutorial"], ["(TP) Analyse", "lab"], ["Analyse - TP groupe B", "lab"], ["Analyse : TD Gr 3", "tutorial"],
		["CM/TD Analyse 2", "lecture"], ["Cours magistral d'Analyse", "lecture"], ["Travaux dirigés Analyse", "tutorial"],
		["Travaux pratiques - Analyse", "lab"], ["Analyse – Amphi A", "lecture"], ["TD de l'Analyse (salle B12)", "tutorial"],
		["Analyse - cours", "lecture"],
	];
	it("gives every spelling the same course key and keeps the meeting type", () => {
		for (const [title, type] of same) {
			assert.equal(courseOf(title).key, "analyse", title);
			assert.equal(courseOf(title).label, "Analyse", title);
			assert.equal(sessionTypeOf(title), type, title);
			assert.equal(classifyEvent(title), "class", title);
		}
		assert.equal(sessionTypeOf("Analyse 2"), null);
	});

	it("keeps course codes whole and never mistakes a group number for a code", () => {
		assert.equal(courseOf("TD01 MAT101").key, "mat101");
		assert.equal(courseOf("MATH201 TP3").key, "math201");
		assert.equal(courseOf("TD12 Algo").key, "algo");
	});

	it("suggests one course for a timetable that names the types, and says how it meets", () => {
		const events: StudyEvent[] = [];
		for (let w = 0; w < 4; w++) events.push(ev("CM Analyse", w * 7 + 1), ev("TD1 Analyse", w * 7 + 2), ev("Analyse - TP", w * 7 + 3), ev("TD2 Analyse", w * 7 + 4));
		const got = suggestCourses(events, {}, [], NOW);
		assert.equal(got.length, 1);
		assert.equal(got[0]!.key, "analyse");
		assert.deepEqual(got[0]!.sessions, { lecture: 4, tutorial: 8, lab: 4 });
		assert.match(got[0]!.reason, /16 classes \(4 lectures, 8 tutorials, 4 labs\)/);
	});

	it("folds groups made under split keys into one, keeping notes and sessions", () => {
		const folded = foldSessionKeys({
			"td analyse": { label: "TD Analyse", noteIds: ["src_aaaaaaaaaaaa"], chatIds: ["c1"] },
			"cm analyse": { label: "CM Analyse", noteIds: ["src_bbbbbbbbbbbb"] },
			analyse: { label: "Analyse", noteIds: ["src_aaaaaaaaaaaa"], chatIds: ["c2"] },
			math201: { label: "MATH201" },
		});
		assert.deepEqual(Object.keys(folded).sort(), ["analyse", "math201"]);
		assert.deepEqual(folded.analyse!.noteIds?.sort(), ["src_aaaaaaaaaaaa", "src_bbbbbbbbbbbb"]);
		assert.deepEqual(folded.analyse!.chatIds?.sort(), ["c1", "c2"]);
		assert.deepEqual(folded.analyse!.aliases?.sort(), ["cm analyse", "td analyse"]);
		assert.deepEqual(foldSessionKeys({ "td analyse": { label: "TD Analyse" } }), { analyse: { label: "TD Analyse", aliases: ["td analyse"] } });
	});

	it("plans a different prep before a tutorial than before a lab, in the same course", () => {
		const topic = (key: string): TopicRetention => ({
			key, kind: "proposition", title: key, chatId: "x", chatTitle: "Analyse", answers: 4, reviews: 3, lapses: 3, lastReviewedAt: NOW - 20 * DAY,
			lastGrade: 1, stability: 1, difficulty: 8, retention: 0.3, dueAt: NOW - DAY, due: true,
		});
		const links = { analyse: { label: "Analyse", chatIds: ["x"] } };
		const prep = (title: string) => {
			const plan = planBriefing({ now: NOW, events: [ev(title, 1)], topics: [topic("t1")], sessions: [], links, confidentMissChats: new Set() });
			return plan.study!.days.flatMap((d) => d.items).find((i) => i.action === "prep")!;
		};
		const td = prep("TD2 Analyse");
		const tp = prep("TP Analyse");
		assert.equal(td.session, "tutorial");
		assert.match(td.title, /^Before the tutorial/);
		assert.match(startPrompt(td), /exercises.*check my method/);
		assert.equal(tp.session, "lab");
		assert.match(startPrompt(tp), /theory behind the lab/);
		assert.equal(planBriefing({ now: NOW, events: [ev("CM Analyse", 1), ev("TD Analyse", 1)], topics: [topic("t1")], sessions: [], links, confidentMissChats: new Set() }).todayClasses.length, 0);
	});
});

describe("folder helpers", () => {
	it("names a folder file by its path and takes only notes files", () => {
		assert.equal(folderNoteName("Analyse/Ch 1/slides.pdf"), "Analyse › Ch 1 › slides.pdf");
		assert.equal(folderNoteName("solo.md"), "solo.md");
		assert.ok(isNotesFile("A/b.PDF") && isNotesFile("a.txt") && isNotesFile("a.md"));
		assert.ok(!isNotesFile("A/b.docx") && !isNotesFile("A/.hidden/b.pdf") && !isNotesFile(".DS_Store"));
	});
});

describe("course groups on disk", () => {
	const note = (name: string) => notesLibrary.save({ name, bytes: new TextEncoder().encode(name), text: name, kind: "text" });

	it("creates a group from a suggestion or a name, and keeps it idempotent", () => {
		const { key } = courses.createCourse({ label: "  Analyse   2 ", key: "analyse" });
		assert.equal(key, "analyse");
		assert.equal(courses.readCourseLinks()["analyse"]!.label, "Analyse 2");
		courses.createCourse({ label: "Other name", key: "analyse" });
		assert.equal(courses.readCourseLinks()["analyse"]!.label, "Analyse 2");
		assert.equal(courses.createCourse({ label: "Linear Algebra - Lecture" }).key, "linear algebra");
		assert.throws(() => courses.createCourse({ label: "  " }), /name/);
	});

	it("adds and removes notes, ignoring files that are not saved, and keeps links when sessions change", () => {
		const a = note("a.txt");
		courses.updateCourse("analyse", { addNoteIds: [a.id, "src_000000000000", "nope"] });
		assert.deepEqual(courses.readCourseLinks()["analyse"]!.noteIds, [a.id]);
		courses.setCourseLink("analyse", "ignored", ["chat1"]);
		assert.deepEqual(courses.readCourseLinks()["analyse"]!.noteIds, [a.id]);
		assert.equal(courses.readCourseLinks()["analyse"]!.label, "Analyse 2");
		courses.updateCourse("analyse", { removeNoteIds: [a.id] });
		assert.deepEqual(courses.readCourseLinks()["analyse"]!.noteIds, []);
	});

	it("lists a group's saved notes and drops files removed from the library", () => {
		const b = note("b.txt");
		courses.addNotesToCourse("analyse", [b.id]);
		assert.deepEqual(courses.listCourses([]).courses.find((c) => c.key === "analyse")!.notes.map((x) => x.name), ["b.txt"]);
		assert.deepEqual(courses.courseMaterial()["analyse"]!.notes.map((x) => x.id), [b.id]);
		notesLibrary.remove(b.id);
		assert.deepEqual(courses.listCourses([]).courses.find((c) => c.key === "analyse")!.notes, []);
	});

	it("folds a calendar course in as an alias, refuses a second owner, and shows the next event", () => {
		courses.updateCourse("analyse", { addAlias: "math201" });
		assert.throws(() => courses.updateCourse("linear algebra", { addAlias: "math201" }), /already/);
		const view = courses.listCourses([ev("MATH201 Lecture 3", 2)], NOW).courses.find((c) => c.key === "analyse")!;
		assert.equal(view.next?.title, "MATH201 Lecture 3");
	});

	it("remembers dismissed suggestions, and creating the group again lifts the dismissal", () => {
		courses.dismissCourseSuggestion("thermodynamique");
		assert.ok(!courses.listCourses(timetable(), NOW).suggestions.some((s) => s.key === "thermodynamique"));
		courses.createCourse({ label: "Thermo", key: "thermodynamique" });
		assert.deepEqual(courses.readDismissedCourses(), []);
		courses.deleteCourse("thermodynamique");
		assert.ok(courses.listCourses(timetable(), NOW).suggestions.some((s) => s.key === "thermodynamique"));
	});

	it("reads old session-only links as groups", () => {
		fs.writeFileSync(path.join(TMP_DATA, "briefing", "courses.json"), JSON.stringify({ old: { label: "Old", chatIds: ["c1"] } }));
		assert.deepEqual(courses.readCourseLinks(), { old: { label: "Old", chatIds: ["c1"] } });
		assert.throws(() => courses.deleteCourse("missing"), /gone/);
	});
});

describe("groups saved before CM, TD and TP were one course", () => {
	it("are folded when read, and the merged file is saved", () => {
		const file = path.join(TMP_DATA, "briefing", "courses.json");
		fs.writeFileSync(file, JSON.stringify({ "td analyse": { label: "TD Analyse", chatIds: ["c1"] }, "cm analyse": { label: "CM Analyse", noteIds: [] } }));
		const links = courses.readCourseLinks();
		assert.deepEqual(Object.keys(links), ["analyse"]);
		assert.deepEqual(links.analyse!.chatIds, ["c1"]);
		assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8"))), ["analyse"]);
		assert.equal(courses.listCourses([{ id: "x", title: "TP2 Analyse", start: NOW + DAY, end: NOW + DAY + HOUR, allDay: false, source: "calendar" }], NOW).courses[0]!.next?.title, "TP2 Analyse");
	});
});

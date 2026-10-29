/**
 * The class calendar (src/core/course-calendar.ts, src/server/course-calendar.ts):
 * every event is filed, ignored or unplaced, and the learner's hand-filed
 * choices win over the classifier and survive it running again.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { applyPins, coverage, guessGroup, IGNORED, NO_PINS, placeEvent, placeEvents, prunePins, titleKey } from "../src/core/course-calendar.ts";
import { courseKeyOfEvent, planBriefing, topicsForEvent, type CourseLinks, type StudyEvent } from "../src/core/briefing.ts";
import { suggestCourses } from "../src/core/courses.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-calendar-"));
process.env.LH_DATA_DIR = TMP_DATA;
const courses = await import("../src/server/courses.ts");
const calendar = await import("../src/server/course-calendar.ts");
after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const NOW = new Date(2026, 10, 5, 11, 20).getTime();
let n = 0;
function ev(title: string, hoursAhead = 24, over: Partial<StudyEvent> = {}): StudyEvent {
	const start = NOW + hoursAhead * HOUR;
	return { id: `e${n++}`, title, start, end: start + 2 * HOUR, allDay: false, source: "calendar", ...over };
}

const links: CourseLinks = {
	analyse: { label: "Analyse", noteIds: [] },
	thermodynamique: { label: "Thermodynamique", noteIds: [] },
};

describe("placeEvent", () => {
	it("files what the groups already match, as the classifier's work", () => {
		const p = placeEvent(ev("CM Analyse"), links, NO_PINS, []).placement;
		assert.deepEqual(p, { state: "filed", key: "analyse", by: "auto" });
	});

	it("leaves an unknown exam unplaced, and the gym ignored", () => {
		assert.equal(placeEvent(ev("Examen intermédiaire"), links, NO_PINS, []).placement.state, "unplaced");
		assert.deepEqual(placeEvent(ev("Gym"), links, NO_PINS, []).placement, { state: "ignored", by: "auto" });
		assert.equal(placeEvent(ev("Fête de Léa", 5, { allDay: true }), links, NO_PINS, []).placement.state, "ignored");
	});

	it("suggests the one group a title shares a word with", () => {
		assert.equal(guessGroup(links, { title: "Colle de thermodynamique" }), "thermodynamique");
		assert.equal(guessGroup(links, { title: "TP Thermo" }), "thermodynamique", "an abbreviation counts");
		assert.equal(guessGroup(links, { title: "Examen intermédiaire" }), null);
		assert.equal(guessGroup(links, { title: "Anal" }), null, "too short to say");
		const both: CourseLinks = { ...links, a2: { label: "Analyse avancée" } };
		assert.equal(guessGroup(both, { title: "Révisions analyse" }), null, "two groups match: no guess");
	});

	it("honours a pin on one event over the classifier", () => {
		const e = ev("CM Analyse");
		const p = placeEvent(e, links, { events: { [e.id]: "thermodynamique" }, titles: {} }, []);
		assert.deepEqual(p.placement, { state: "filed", key: "thermodynamique", by: "you" });
		assert.equal(p.pin, "event");
	});

	it("a title pin reaches every event with that title, however it is spelled", () => {
		const pins = { events: {}, titles: { [titleKey("Salle B12")]: "analyse" } };
		for (const t of ["Salle B12", "salle  b12", "SALLE B12"]) {
			const p = placeEvent(ev(t), links, pins, []);
			assert.deepEqual(p.placement, { state: "filed", key: "analyse", by: "you" }, t);
			assert.equal(p.pin, "title");
		}
		assert.equal(placeEvent(ev("Salle B13"), links, pins, []).placement.state, "unplaced");
	});

	it("an event pin beats a title pin; 'not a class' is a pin too", () => {
		const e = ev("Examen intermédiaire");
		const pins = { events: { [e.id]: IGNORED }, titles: { [titleKey(e.title)]: "analyse" } };
		assert.deepEqual(placeEvent(e, links, pins, []).placement, { state: "ignored", by: "you" });
	});

	it("a pin whose group was deleted leaves the event unplaced, not lost", () => {
		const e = ev("Examen intermédiaire");
		const pins = { events: { [e.id]: "gone" }, titles: {} };
		assert.equal(placeEvent(e, links, pins, []).placement.state, "unplaced");
		assert.deepEqual(prunePins(pins, links), { events: {}, titles: {} });
	});

	it("a pin survives the classifier changing its mind", () => {
		const e = ev("Salle B12");
		const pins = { events: {}, titles: { [titleKey(e.title)]: "analyse" } };
		// A group made later whose name matches the title would claim it automatically.
		const later: CourseLinks = { ...links, "salle b": { label: "Salle B" } };
		assert.deepEqual(placeEvent(e, later, pins, []).placement, { state: "filed", key: "analyse", by: "you" });
	});
});

describe("placeEvents and coverage", () => {
	it("counts every calendar event once, skipping to-do tasks", () => {
		const events = [ev("CM Analyse"), ev("Examen intermédiaire"), ev("Gym"), ev("Rendre le devoir", 30, { source: "todo" })];
		const placed = placeEvents(events, links, NO_PINS, []);
		assert.equal(placed.length, 3);
		assert.deepEqual(coverage(placed), { total: 3, filed: 1, ignored: 1, unplaced: 1 });
	});
});

describe("the rest of the app reads hand-filed events", () => {
	it("applyPins tags a pinned event with its group and takes an ignored one out of the plan", () => {
		const exam = ev("Examen intermédiaire", 48);
		const talk = ev("Conférence", 30);
		const pins = { events: { [exam.id]: "analyse", [talk.id]: IGNORED }, titles: {} };
		const [a, b] = applyPins([exam, talk], links, pins);
		assert.equal(a!.courseKey, "analyse");
		assert.equal(courseKeyOfEvent(a!), "analyse");
		assert.equal(b!.ignored, true);
		assert.equal(b!.kind, "other");
	});

	it("topicsForEvent reads the pinned event as that course, with its notes", () => {
		const exam = { ...ev("Examen intermédiaire", 48), courseKey: "analyse" };
		const grouped: CourseLinks = { analyse: { label: "Analyse", noteIds: ["n1"] } };
		const material = { analyse: { topicKeys: ["prop:x"], notes: [{ id: "n1", name: "Chap 1.pdf" }] } };
		const got = topicsForEvent(exam, [], grouped, [], material);
		assert.equal(got.course.key, "analyse");
		assert.deepEqual(got.notes, [{ id: "n1", name: "Chap 1.pdf" }]);
	});

	it("a hand-filed exam reaches the plan as that course's exam", () => {
		const exam = ev("Examen intermédiaire", 48, { kind: "exam", courseKey: "analyse" });
		const plan = planBriefing({
			now: NOW,
			events: [exam],
			topics: [],
			sessions: [],
			links: { analyse: { label: "Analyse", noteIds: [] } },
			material: {},
			confidentMissChats: new Set(),
			budgetMinutes: 45,
			previous: null,
		});
		assert.equal(plan.upcoming[0]?.course.key, "analyse");
	});

	it("an event filed by hand is no longer a course suggestion", () => {
		const events = [ev("Atelier optique", 24), ev("Atelier optique", 48 * 3), ev("Atelier optique", 24 * 9)];
		assert.equal(suggestCourses(events, {}, [], NOW).length, 1);
		assert.equal(suggestCourses(events.map((e) => ({ ...e, courseKey: "analyse" })), {}, [], NOW).length, 0);
		assert.equal(suggestCourses(events.map((e) => ({ ...e, ignored: true })), {}, [], NOW).length, 0);
	});
});

describe("hand-filed pins on disk", () => {
	it("sets, clears and undoes pins, and deleting a group frees its events", () => {
		const made = courses.createCourse({ label: "Optique" });
		const key = made.key;
		const first = courses.setCoursePins([
			{ scope: "title", id: titleKey("Salle B12"), value: key },
			{ scope: "event", id: "evt-1", value: IGNORED },
		]);
		assert.equal(courses.readCoursePins().titles[titleKey("Salle B12")], key);
		assert.equal(courses.readCoursePins().events["evt-1"], IGNORED);
		// Undo: the previous values were "nothing", so the pins are cleared.
		courses.setCoursePins(first.undo);
		assert.deepEqual(courses.readCoursePins(), { events: {}, titles: {} });

		courses.setCoursePins([{ scope: "title", id: "salle b12", value: key }]);
		courses.deleteCourse(key);
		assert.deepEqual(courses.readCoursePins().titles, {}, "pins to a deleted group are dropped");
	});

	it("refuses a pin to a group that does not exist", () => {
		assert.throws(() => courses.setCoursePins([{ scope: "event", id: "x", value: "nope" }]), /gone/);
		assert.throws(() => courses.setCoursePins([{ scope: "bogus" as "event", id: "x", value: null }]), /scope/);
	});

	it("with no calendar connected and no briefing, the tab is empty but works", async () => {
		const cal = await calendar.courseCalendar({ now: NOW });
		assert.equal(cal.source, "none");
		assert.equal(cal.events.length, 0);
		assert.equal(cal.coverage.total, 0);
	});
});

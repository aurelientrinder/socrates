import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	GRADE_AGAIN,
	GRADE_GOOD,
	GRADE_HARD,
	SITTING_GAP_MS,
	parseTopicKey,
	planNodeMessageIds,
	resolvePlanToPropositions,
	retentionReport,
	type RecallEvent,
} from "../src/core/retention.ts";
import { cardSchedule, flashcardRecallEvents, type FlashcardDeck } from "../src/core/flashcards.ts";
import { isNoteSourceId, sessionHref } from "../src/core/exam.ts";
import { planBriefing } from "../src/core/briefing.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("unified memory silos", () => {
	it("parseTopicKey handles plan, prop, and card keys", () => {
		assert.deepEqual(parseTopicKey("plan:c1:n1"), { topicKey: "plan:c1:n1", kind: "plan", topicId: "n1" });
		assert.deepEqual(parseTopicKey("prop:n_abc"), { topicKey: "prop:n_abc", kind: "proposition", topicId: "n_abc" });
		assert.deepEqual(parseTopicKey("card:src_1:fc_9"), { topicKey: "card:src_1:fc_9", kind: "card", topicId: "fc_9" });
		assert.equal(parseTopicKey("bogus"), null);
	});

	it("planNodeMessageIds attributes prose turns and check calls to each plan node", () => {
		const messages = [
			{ id: "m1", role: "assistant", content: [{ type: "text", text: "Intro to eigenvalues." }] },
			{
				id: "m2",
				role: "assistant",
				content: [
					{ type: "text", text: "Check your understanding:" },
					{ type: "toolCall", id: "tc1", name: "quiz", arguments: { nodeId: "eig", type: "check" } },
				],
			},
			{ id: "m3", role: "assistant", content: [{ type: "text", text: "Now diagonalization." }] },
			{
				id: "m4",
				role: "assistant",
				content: [{ type: "toolCall", id: "tc2", name: "explain", arguments: { nodeId: "diag" } }],
			},
		];
		assert.deepEqual(planNodeMessageIds(messages), {
			eig: ["m1", "m2"],
			diag: ["m3", "m4"],
		});
	});

	it("resolvePlanToPropositions maps plan checks & their reviews onto canonical graph propositions with fallback", () => {
		const t0 = Date.UTC(2026, 10, 1);
		const events: RecallEvent[] = [
			// Lesson check on eig (mapped to 1 proposition)
			{
				topicKey: "plan:chat_1:eig",
				kind: "plan",
				topicId: "eig",
				title: "Eigenvalues",
				chatId: "chat_1",
				chatTitle: "Linear Algebra",
				at: t0,
				grade: GRADE_GOOD,
			},
			// Later review session targeting that plan key (different chatId!)
			{
				topicKey: "plan:chat_1:eig",
				kind: "plan",
				topicId: "eig",
				title: "eig",
				chatId: "chat_rev",
				chatTitle: "Review",
				at: t0 + 3 * DAY_MS,
				grade: GRADE_GOOD,
				review: true,
			},
			// Lesson check on diag (mapped to 2 propositions)
			{
				topicKey: "plan:chat_1:diag",
				kind: "plan",
				topicId: "diag",
				title: "Diagonalization",
				chatId: "chat_1",
				chatTitle: "Linear Algebra",
				at: t0,
				grade: GRADE_HARD,
			},
			// Unextracted node stays plan:*
			{
				topicKey: "plan:chat_1:unextracted",
				kind: "plan",
				topicId: "unextracted",
				title: "Jordan form",
				chatId: "chat_1",
				chatTitle: "Linear Algebra",
				at: t0,
				grade: GRADE_GOOD,
			},
		];

		const planMessages = new Map([
			["chat_1", { eig: ["m1", "m2"], diag: ["m3", "m4"], unextracted: ["m9"] }],
		]);
		const nodes = [
			{ id: "n_eig", name: "Eigenvalue equation", provenance: [{ chatId: "chat_1", messageId: "m1" }] },
			{ id: "n_diag1", name: "Diagonalizability criterion", provenance: [{ chatId: "chat_1", messageId: "m3" }] },
			{ id: "n_diag2", name: "Similarity transform", provenance: [{ chatId: "chat_1", messageId: "m4" }] },
		];

		const resolved = resolvePlanToPropositions(events, planMessages, nodes);
		const report = retentionReport(resolved, t0 + 4 * DAY_MS);

		const eig = report.topics.find((t) => t.key === "prop:n_eig");
		assert.ok(eig, "plan:chat_1:eig collapsed into prop:n_eig");
		assert.equal(eig.title, "Eigenvalue equation");
		assert.equal(eig.chatId, "chat_1");
		assert.equal(eig.reviews, 2, "lesson check + later review merged into one FSRS history");

		assert.ok(report.topics.some((t) => t.key === "prop:n_diag1"));
		assert.ok(report.topics.some((t) => t.key === "prop:n_diag2"));
		assert.ok(!report.topics.some((t) => t.key === "plan:chat_1:diag"));
		assert.ok(report.topics.some((t) => t.key === "plan:chat_1:unextracted"), "unextracted node preserved as fallback");
	});

	it("flashcardRecallEvents links nodeId to prop:*, keeps unlinked as card:*, and matches cardSchedule", () => {
		const t0 = Date.UTC(2026, 10, 1);
		const decks: FlashcardDeck[] = [
			{
				noteId: "src_alg",
				noteName: "Algebra Notes",
				generatedAt: t0,
				cards: [
					{
						id: "fc_1",
						front: "What is Av = λv?",
						back: "The eigenvalue equation.",
						quote: "Av = λv",
						nodeId: "n_eig",
						createdAt: t0,
						reviews: [
							// Same sitting: first answer Again, retry Good 5 min later → sitting grades Again
							{ at: t0, grade: GRADE_AGAIN },
							{ at: t0 + 5 * 60 * 1000, grade: GRADE_GOOD },
							// Next sitting 2 days later → Good
							{ at: t0 + 2 * DAY_MS, grade: GRADE_GOOD },
						],
					},
					{
						id: "fc_2",
						front: "Unlinked card",
						back: "Answer",
						quote: "quote",
						createdAt: t0,
						reviews: [{ at: t0, grade: GRADE_GOOD }],
					},
					{
						id: "fc_dead",
						front: "Deleted node card",
						back: "Answer",
						quote: "quote",
						nodeId: "n_deleted",
						createdAt: t0,
						reviews: [{ at: t0, grade: GRADE_HARD }],
					},
					{
						id: "fc_new",
						front: "Never answered",
						back: "Answer",
						quote: "quote",
						createdAt: t0,
						reviews: [],
					},
				],
			},
		];

		const names = new Map([["n_eig", "Eigenvalue equation"]]);
		const events = flashcardRecallEvents(decks, names);
		const now = t0 + 3 * DAY_MS;

		// Linked card emitted as prop:n_eig with review: true
		const eigEvents = events.filter((e) => e.topicKey === "prop:n_eig");
		assert.equal(eigEvents.length, 2, "two sittings collapsed with first-answer grade");
		assert.equal(eigEvents[0]!.grade, GRADE_AGAIN);
		assert.equal(eigEvents[0]!.review, true);
		assert.equal(eigEvents[1]!.grade, GRADE_GOOD);

		// Stability & dueAt match cardSchedule identically
		const cardSched = cardSchedule(decks[0]!.cards[0]!.reviews, now);
		const folded = retentionReport(eigEvents, now).topics[0]!;
		assert.equal(folded.stability, cardSched.stability);
		assert.equal(folded.dueAt, cardSched.dueAt);

		// Unlinked card & dead-node card fall back to card:*
		assert.ok(events.some((e) => e.topicKey === "card:src_alg:fc_2" && e.kind === "card"));
		assert.ok(events.some((e) => e.topicKey === "card:src_alg:fc_dead" && e.kind === "card"));
		assert.ok(!events.some((e) => e.topicId === "fc_new"), "unanswered cards emit nothing");
		assert.ok(SITTING_GAP_MS > 0);
	});

	it("sessionHref routes note sources to the Cards tab", () => {
		assert.equal(isNoteSourceId("src_abc123"), true);
		assert.equal(sessionHref("src_abc123"), "/progress?tab=cards");
		assert.equal(sessionHref("chat_xyz"), "/chat/chat_xyz");
	});

	it("planBriefing counts course note cards in exam readiness without putting card:* in conversational review steps", () => {
		const now = Date.UTC(2026, 10, 10, 9, 0);
		const cardEvents = flashcardRecallEvents([
			{
				noteId: "src_phys",
				noteName: "Physics Notes",
				generatedAt: now - 10 * DAY_MS,
				cards: [
					{
						id: "fc_1",
						front: "State Gauss's law",
						back: "∇·E = ρ/ε₀",
						quote: "∇·E = ρ/ε₀",
						createdAt: now - 10 * DAY_MS,
						reviews: [{ at: now - 8 * DAY_MS, grade: GRADE_AGAIN }],
					},
				],
			},
		]);
		const report = retentionReport(cardEvents, now);
		const plan = planBriefing({
			now,
			events: [
				{
					id: "ev_1",
					title: "Physics Midterm Exam",
					start: now + 5 * DAY_MS,
					end: now + 5 * DAY_MS + 2 * 3600 * 1000,
					allDay: false,
					source: "calendar",
					kind: "exam",
					courseKey: "physics",
				},
			],
			topics: report.topics,
			sessions: [],
			links: { physics: { label: "Physics", noteIds: ["src_phys"] } },
			material: { physics: { notes: [{ id: "src_phys", name: "Physics Notes" }], topicKeys: [] } },
			confidentMissChats: new Set(),
		});

		assert.equal(plan.upcoming.length, 1);
		assert.equal(plan.upcoming[0]!.topicCount, 1, "course note card counts toward exam readiness");
		assert.ok(plan.upcoming[0]!.readiness !== null);
		// No conversational review/check/prep item should carry card:* keys
		for (const item of plan.items) {
			assert.ok(
				item.topicKeys.every((k) => !k.startsWith("card:")),
				"conversational Today steps never schedule raw card:* keys",
			);
		}
	});
});

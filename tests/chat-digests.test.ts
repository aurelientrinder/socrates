/**
 * CHAT DIGESTS + YOUR DATA (src/server/chat-digests.ts, backup.ts):
 * - the reports read digests, re-deriving only chats that changed;
 * - a deleted chat's history survives ("preserve-graph") unless the
 *   learner erased the topics;
 * - Today's study record counts flashcard rounds and mock exam sittings;
 * - the export carries the learner's data and no secrets.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-digests-"));
process.env.LH_DATA_DIR = TMP_DATA;

const server = await import("../src/server/index.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { flashcardStore } = await import("../src/store/flashcards.ts");
const { examStore } = await import("../src/store/exams.ts");
const { chatDigests } = await import("../src/server/chat-digests.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function quizResult(chatTitle: string, answeredAt: string, correct: boolean, confidence: number) {
	return {
		role: "toolResult",
		toolCallId: `t_${answeredAt}`,
		toolName: "quiz",
		content: [],
		isError: false,
		timestamp: Date.parse(answeredAt),
		details: { kind: "quiz", answeredAt, correct, confidence, questionText: `Q about ${chatTitle}`, dontKnow: false },
	};
}

describe("chat digests", () => {
	it("derives calibration answers once and re-derives only after the chat changes", async () => {
		const chat = chatStore.createChat("Limits");
		chatStore.saveMessages(chat.id, [quizResult("Limits", "2026-10-27T10:00:00.000Z", false, 90)] as never);
		assert.equal(server.calibrationAcrossSessions().answered, 1);
		const digestFile = path.join(TMP_DATA, "digests", `${chat.id}.json`);
		assert.ok(fs.existsSync(digestFile), "the digest is persisted");

		// Unchanged chat: the digest is reused, not rebuilt.
		const before = fs.statSync(digestFile).mtimeMs;
		server.calibrationAcrossSessions();
		assert.equal(fs.statSync(digestFile).mtimeMs, before);

		// Changed chat: the digest follows.
		await new Promise((r) => setTimeout(r, 15));
		chatStore.saveMessages(chat.id, [
			quizResult("Limits", "2026-10-27T10:00:00.000Z", false, 90),
			quizResult("Limits", "2026-10-27T10:01:00.000Z", true, 60),
		] as never);
		assert.equal(server.calibrationAcrossSessions().answered, 2);
	});

	it("keeps a deleted chat's history, and drops it when the topics are erased", async () => {
		const kept = chatStore.createChat("Kept");
		chatStore.saveMessages(kept.id, [quizResult("Kept", "2026-10-27T11:00:00.000Z", true, 80)] as never);
		const gone = chatStore.createChat("Erased");
		chatStore.saveMessages(gone.id, [quizResult("Erased", "2026-10-27T11:05:00.000Z", true, 80)] as never);
		const total = server.calibrationAcrossSessions().answered;

		assert.equal((await server.deleteChatSession(kept.id, "preserve-graph")).ok, true);
		assert.equal(server.calibrationAcrossSessions().answered, total, "history outlives the session");
		assert.ok(chatDigests().some((d) => d.chatId === kept.id && d.archived));

		assert.equal((await server.deleteChatSession(gone.id, "delete-nodes")).ok, true);
		assert.equal(server.calibrationAcrossSessions().answered, total - 1);
	});

	it("keeps a corrupt chat's last digest instead of dropping it from every report", () => {
		const chat = chatStore.createChat("Fragile");
		chatStore.saveMessages(chat.id, [quizResult("Fragile", "2026-10-27T12:00:00.000Z", true, 70)] as never);
		const before = server.calibrationAcrossSessions().answered;
		fs.writeFileSync(path.join(TMP_DATA, "chats", `${chat.id}.json`), "{ not json");
		assert.equal(server.calibrationAcrossSessions().answered, before);
	});
});

describe("studyRecord", () => {
	it("counts flashcard rounds and mock exam sittings, not only chat messages", () => {
		const now = new Date(2026, 9, 28, 20, 0);
		const t = (h: number, m: number) => new Date(2026, 9, 28, h, m).getTime();
		const card = (id: string, ats: number[]) => ({
			id,
			front: "f",
			back: "b",
			quote: "q",
			createdAt: t(8, 0),
			reviews: ats.map((at) => ({ at, grade: 3 })),
		});
		flashcardStore.save({
			noteId: "src_aaaaaaaaaaaa",
			noteName: "notes.pdf",
			generatedAt: t(8, 0),
			cards: [card("a", [t(9, 0), t(9, 2)]), card("b", [t(9, 4), t(9, 6)])],
		} as never);
		examStore.save({
			id: "exam_x_00000000",
			title: "Mock",
			status: "graded",
			problems: [],
			createdAt: new Date(t(13, 0)).toISOString(),
			startedAt: new Date(t(14, 0)).toISOString(),
			submittedAt: new Date(t(15, 0)).toISOString(),
		} as never);
		const { week, streak } = server.studyRecord(now);
		const wednesday = week[2]!; // 2026-10-28 is a Wednesday
		assert.ok(wednesday >= 66, `flashcards (6 min) + exam (60 min) count, got ${wednesday}`);
		assert.equal(streak.studiedToday, true);
	});
});

describe("export", () => {
	it("bundles the learner's data and leaves secrets out", () => {
		fs.writeFileSync(path.join(TMP_DATA, "auth.json"), '{"GEMINI_API_KEY":"secret"}');
		const bundle = server.exportData();
		assert.equal(bundle.app, "socrates");
		assert.ok(Object.keys(bundle.files).some((f) => f.startsWith("chats/")));
		assert.ok(Object.keys(bundle.files).some((f) => f.startsWith("flashcards/")));
		assert.ok(!JSON.stringify(bundle).includes("secret"));
	});
});

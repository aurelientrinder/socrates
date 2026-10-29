/** The class lens (src/core/course-lens.ts): a class owns sessions; looking at one keeps its cross-class links. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classOfSession, classView, colorsFor, CLASS_COLORS } from "../src/core/course-lens.ts";

const analyse = { key: "analyse", label: "Analyse", sessions: ["chat1", "src_aaaaaaaaaaaa"], color: 0 };
const thermo = { key: "thermo", label: "Thermo", sessions: ["chat2"], color: 1 };

describe("class lens", () => {
	it("finds the class of a session", () => {
		assert.equal(classOfSession([analyse, thermo], "chat2")?.key, "thermo");
		assert.equal(classOfSession([analyse, thermo], "chat9"), null);
	});

	it("gives classes the same colors on every screen, whatever the order they come in", () => {
		const a = colorsFor(["b", "a", "c"]);
		const b = colorsFor(["c", "a", "b"]);
		assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
		assert.equal(a.get("a"), 0);
		assert.equal(colorsFor(Array.from({ length: CLASS_COLORS + 1 }, (_, i) => `k${String(i).padStart(2, "0")}`)).get(`k0${CLASS_COLORS}`), 0);
	});

	it("shows a class's own nodes and what they connect to in other classes, but not unrelated ones", () => {
		// a1 -> imp1 -> t1 crosses classes; a2 stands alone; t2 -> imp2 -> t3 is all thermo.
		const on = (id: string, chatId?: string) => ({ id, provenance: chatId ? [{ chatId }] : [] });
		const nodes = [on("a1", "chat1"), on("a2", "src_aaaaaaaaaaaa"), on("t1", "chat2"), on("t2", "chat2"), on("t3", "chat2"), on("imp1"), on("imp2")];
		const edges = [
			{ from: "a1", to: "imp1" },
			{ from: "imp1", to: "t1" },
			{ from: "t2", to: "imp2" },
			{ from: "imp2", to: "t3" },
		];
		const v = classView(nodes, edges, analyse);
		assert.deepEqual([...v.own].sort(), ["a1", "a2"]);
		assert.deepEqual([...v.shown].sort(), ["a1", "a2", "imp1", "t1"]);
	});
});

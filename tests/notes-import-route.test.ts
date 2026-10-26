import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { GraphStore } from "../src/core/ports.ts";
import type { GraphNode, GraphChain, NotesSource, SessionCheckpoint } from "../src/core/contracts.ts";

// Every import now saves its file to the notes library (data/notes): an
// isolated data dir, set before the first config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-import-"));
process.env.LH_DATA_DIR = TMP_DATA;
const { POST } = await import("../app/api/graph/import/route.ts");
const { extraction, notesLibrary } = await import("../src/server/index.ts");
const { ModelsNotConfiguredError, ProviderKeyMissingError } = await import("../src/core/settings.ts");
const { createExtractionPipeline, NotesImportError } = await import("../src/agent/subagents/extraction.ts");
const { stores } = await import("../src/server/stores.ts");
const { noteIdFor } = await import("../src/store/notes.ts");
after(() => { fs.rmSync(TMP_DATA, { recursive: true, force: true }); });

const original = extraction.importNotes;
after(() => { extraction.importNotes = original; });
function request(names: string[], body: (name: string) => BlobPart = () => "identical text") {
	const form = new FormData();
	for (const name of names) form.append("files", new File([body(name)], name));
	return new Request("http://localhost/api/graph/import", { method: "POST", body: form });
}

it("route keeps three-worker batching, request positions and mixed per-file outcomes/config details", async () => {
	let active = 0;
	let peak = 0;
	extraction.importNotes = async ({ filePath }) => {
		active++; peak = Math.max(peak, active);
		try {
			await new Promise((resolve) => setTimeout(resolve, filePath === "slow.md" ? 25 : 1));
			if (filePath === "models.md") throw new ModelsNotConfiguredError(["cheap"]);
			if (filePath === "key.md") throw new ProviderKeyMissingError("openai", ["cheap"]);
			if (["failed", "partial", "aborted", "busy"].includes(filePath)) throw new NotesImportError(filePath as InstanceType<typeof NotesImportError>["outcome"], { nodes: 2, chains: 1 }, `synthetic ${filePath}`);
			if (filePath === "unknown.md") throw new Error("synthetic unknown error");
			return { nodes: 0, chains: 0 };
		} finally { active--; }
	};
	const names = ["slow.md", "same.md", "same.md", "failed", "partial", "aborted", "busy", "models.md", "key.md", "unknown.md"];
	const response = await POST(request(names));
	assert.equal(response.status, 200);
	const { results } = await response.json();
	assert.equal(peak, 3);
	assert.notEqual(results[0].requestIndex, 0, "out-of-order completion remains supported");
	assert.equal(results.length, names.length);
	for (const [requestIndex, filePath] of names.entries()) {
		const result = results.find((r: { requestIndex: number }) => r.requestIndex === requestIndex);
		assert.equal(result.filePath, filePath);
		if (["failed", "partial", "aborted", "busy"].includes(filePath)) {
			assert.equal(result.outcome, filePath);
			assert.equal(result.ok, false);
			assert.deepEqual(result.stats, { nodes: 2, chains: 1 });
		} else if (["slow.md", "same.md"].includes(filePath)) {
			assert.equal(result.outcome, "completed"); assert.equal(result.ok, true);
		} else { assert.equal(result.ok, false); assert.equal(result.outcome, "failed"); }
	}
	assert.deepEqual(results.find((r: { filePath: string }) => r.filePath === "models.md").missing, ["cheap"]);
	const key = results.find((r: { filePath: string }) => r.filePath === "key.md");
	assert.equal(key.code, "provider_key_missing"); assert.equal(key.provider, "openai"); assert.deepEqual(key.slots, ["cheap"]);
});

it("real route plus in-memory ledgers and faux stages reprocess identical imports for all four filename cases", async () => {
	const nodes: GraphNode[] = [];
	const chains: GraphChain[] = [];
	const checkpoints: SessionCheckpoint[] = [];
	const sources = new Map<string, NotesSource>();
	const graphStore: GraphStore = {
		appendNode: (node) => { nodes.push(node); }, readNodes: () => [...nodes],
		appendChain: (chain) => { chains.push(chain); }, readChains: () => [...chains],
		appendCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); }, readCheckpoints: () => [...checkpoints],
		appendCoverage: () => {}, readCoverage: () => [],
		upsertSource: (source) => { sources.set(source.id, { ...source, extractions: sources.get(source.id)?.extractions ?? [] }); },
		readSources: () => [...sources.values()],
		appendSourceUsage: (id, usage) => { sources.get(id)!.extractions!.push(usage); },
		readPositions: () => ({}), writePositions: () => {}, rewriteLedgers: () => {},
	};
	let calls = 0;
	const pipeline = createExtractionPipeline({ chatStore: stores.chatStore, graphStore,
		engineFor: (role) => {
			const faux = createFauxCore({});
			faux.setResponses([() => {
				if (role === "extractor") calls++;
				return fauxAssistantMessage([fauxToolCall(role === "extractor" ? "submit_findings" : "submit_review", role === "extractor" ? {
					propositions: [{ id: "p1", name: "Synthetic import", statement: "Explicit notes imports process the whole file.", aliases: [] }], chains: [],
				} : { links: [] })], { stopReason: "toolUse" });
			}]);
			return { model: faux.getModel(), streamFn: faux.streamSimple };
		},
	});
	extraction.importNotes = pipeline.importNotes;
	const names = ["1.md", "1.1.md", "1 notes.md", "1.1 notes.md"];
	for (let pass = 0; pass < 2; pass++) {
		const response = await POST(request(names));
		const { results } = await response.json();
		assert.equal(results.length, 4);
		assert.ok(results.every((r: { ok: boolean; outcome: string }) => r.ok && r.outcome === "completed"));
	}
	assert.equal(calls, 8, "repeat identical imports execute real faux extractor calls");
	assert.equal(nodes.length, 8);
	assert.equal(sources.size, 4);
	assert.deepEqual([...sources.keys()].sort(), names.map(noteIdFor).sort(), "a saved note shares its graph source's id");
	assert.ok([...sources.values()].every((source) => source.extractions?.length === 2 && source.contentFp === undefined));
});

it("route returns 400 without files", async () => {
	const response = await POST(request([]));
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { results: [], error: "no files" });
});

/** A minimal PDF: one page per entry, "" = a page with no text layer (a scan). */
function makePdf(pages: string[]): Uint8Array {
	const objects: string[] = [];
	const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
	objects.push("<< /Type /Catalog /Pages 2 0 R >>");
	objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	for (const [i, text] of pages.entries()) {
		const stream = text ? `BT /F1 12 Tf 72 712 Td (${text}) Tj ET` : "";
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
		objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
	}
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [i, body] of objects.entries()) {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	}
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

it("a PDF is imported as text, saved to the notes library, and its scanned pages are reported", async () => {
	let received = "";
	extraction.importNotes = async ({ text }) => { received = text; return { nodes: 1, chains: 0 }; };
	const pdf = makePdf(["Photosynthesis turns light into sugar in the chloroplast.", "", "The Calvin cycle fixes carbon dioxide into glucose."]);
	const response = await POST(request(["Biology week 3.pdf"], () => pdf as BlobPart));
	const [result] = (await response.json()).results;
	assert.equal(result.ok, true);
	assert.match(result.warning, /1 of 3 pages have no text .*page 2/);
	assert.match(received, /--- Page 1 ---\nPhotosynthesis turns light/);
	assert.match(received, /--- Page 2 ---\n\[no text on this page/);
	assert.match(received, /--- Page 3 ---\nThe Calvin cycle/);

	const [saved] = notesLibrary.list();
	assert.equal(saved!.name, "Biology week 3.pdf");
	assert.equal(saved!.kind, "pdf");
	assert.equal(saved!.pages, 3);
	assert.deepEqual(saved!.emptyPages, [2]);
	assert.equal(notesLibrary.text(saved!.id), received);
	assert.deepEqual(new Uint8Array(fs.readFileSync(notesLibrary.originalPath(saved!.id)!)), pdf);
	assert.equal(path.basename(path.dirname(notesLibrary.originalPath(saved!.id)!)), saved!.id);
});

it("a fully scanned PDF is saved but refused for the map, with what to do instead", async () => {
	let called = false;
	extraction.importNotes = async () => { called = true; return { nodes: 0, chains: 0 }; };
	const response = await POST(request(["scan.pdf"], () => makePdf(["", ""]) as BlobPart));
	const [result] = (await response.json()).results;
	assert.equal(result.ok, false);
	assert.match(result.error, /looks scanned/);
	assert.equal(called, false);
	assert.ok(notesLibrary.list().some((n) => n.name === "scan.pdf"));
});

it("a text file is saved too, and a broken PDF is refused with a readable message", async () => {
	extraction.importNotes = async () => ({ nodes: 0, chains: 0 });
	const response = await POST(request(["lecture.md", "broken.pdf"], (name) => (name === "broken.pdf" ? "%PDF-1.4 garbage" : "# Lecture\nEntropy always rises.")));
	const { results } = await response.json();
	const md = results.find((r: { filePath: string }) => r.filePath === "lecture.md");
	const broken = results.find((r: { filePath: string }) => r.filePath === "broken.pdf");
	assert.equal(md.ok, true);
	assert.equal(notesLibrary.text(notesLibrary.list().find((n) => n.name === "lecture.md")!.id), "# Lecture\nEntropy always rises.");
	assert.equal(broken.ok, false);
	assert.match(broken.error, /can't be opened/);
});

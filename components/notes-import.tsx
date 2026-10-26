"use client";

import { useRef, useState } from "react";

// Transport-only types: never import the server's extraction/agent module here.
export interface NotesImportResult {
	requestIndex: number;
	filePath: string;
	ok: boolean;
	outcome: "completed" | "failed" | "partial" | "aborted" | "busy";
	stats?: { nodes: number; chains?: number; droppedChains?: number };
	error?: string;
	/** A completed import's caveat (a PDF's scanned pages were skipped). */
	warning?: string;
	code?: string;
	missing?: string[];
	provider?: string;
	slots?: string[];
}

/** Validate the entire response before applying any row: a malformed index
 * must never attribute another file's success to this file (same names included). */
export function parseNotesImportResults(body: unknown, files: readonly File[]): NotesImportResult[] {
	const invalid = () => new Error("Invalid import response. Please retry the file.");
	if (!body || typeof body !== "object" || !("results" in body) || !Array.isArray(body.results) || body.results.length !== files.length) throw invalid();
	const seen = new Set<number>();
	for (const raw of body.results) {
		if (!raw || typeof raw !== "object") throw invalid();
		const r = raw as NotesImportResult;
		if (!Number.isInteger(r.requestIndex) || r.requestIndex < 0 || r.requestIndex >= files.length || seen.has(r.requestIndex) || r.filePath !== files[r.requestIndex]!.name) throw invalid();
		seen.add(r.requestIndex);
		if (!["completed", "failed", "partial", "aborted", "busy"].includes(r.outcome) || typeof r.ok !== "boolean" || r.ok !== (r.outcome === "completed")) throw invalid();
		if (r.stats !== undefined && (!r.stats || typeof r.stats !== "object" || !Number.isFinite(r.stats.nodes) || r.stats.nodes < 0 || (r.stats.chains !== undefined && (!Number.isFinite(r.stats.chains) || r.stats.chains < 0)))) throw invalid();
		if (r.ok && !r.stats) throw invalid();
		if (!r.ok && typeof r.error !== "string") throw invalid();
		for (const field of ["error", "warning", "code", "provider"] as const) if (r[field] !== undefined && typeof r[field] !== "string") throw invalid();
		for (const field of ["missing", "slots"] as const) if (r[field] !== undefined && (!Array.isArray(r[field]) || !r[field]!.every((v) => typeof v === "string"))) throw invalid();
	}
	return body.results as NotesImportResult[];
}

/** What the import picker accepts — PDFs are turned into text server-side. */
export const NOTES_ACCEPT = ".pdf,.md,.markdown,.txt";

/** Mirrors the server's per-file cap (src/server/notes.ts MAX_NOTE_BYTES):
 *  refuse up front instead of uploading a file the server will refuse. */
const MAX_NOTE_BYTES = 50 * 1024 * 1024;

export async function postNotesImport(files: readonly File[]): Promise<NotesImportResult[]> {
	const form = new FormData();
	for (const file of files) form.append("files", file);
	const response = await fetch("/api/graph/import", { method: "POST", body: form });
	let body: unknown;
	try { body = await response.json(); }
	catch { throw new Error("Invalid import response. Please retry the file."); }
	if (!response.ok) {
		const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
		throw new Error(`Import request failed (HTTP ${response.status})${detail}. Please retry the file.`);
	}
	return parseNotesImportResults(body, files);
}

/** Only error/warning text survives a request; selected Files stay request-local. */
export function useNotesImport(callbacks: { onStart?: () => void; onFinish?: () => void } = {}) {
	const [errors, setErrors] = useState<string[]>([]);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [importing, setImporting] = useState(false);
	const pending = useRef(false);
	const submit = async (picked: File[]) => {
		if (pending.current || picked.length === 0) return;
		const tooBig = picked.filter((file) => file.size > MAX_NOTE_BYTES);
		const files = picked.filter((file) => file.size <= MAX_NOTE_BYTES);
		const sizeErrors = tooBig.map((file) => `${file.name}: this file is ${Math.round(file.size / 1024 / 1024)} MB, over the 50 MB limit. Split the PDF into smaller parts and import those.`);
		setErrors(sizeErrors);
		setWarnings([]);
		if (files.length === 0) return;
		pending.current = true;
		setImporting(true);
		try {
			callbacks.onStart?.();
			const results = (await postNotesImport(files)).sort((a, b) => a.requestIndex - b.requestIndex);
			setErrors([...sizeErrors, ...results
				.filter((result) => !result.ok)
				.map((r) => `${r.filePath}: ${r.error}${r.code ? `\n${r.code}${r.provider ? ` — ${r.provider}` : ""}${r.missing?.length ? ` — ${r.missing.join(", ")}` : ""}${r.slots?.length ? ` — ${r.slots.join(", ")}` : ""}` : ""}`)]);
			setWarnings(results.filter((r) => r.ok && r.warning).map((r) => `${r.filePath}: ${r.warning}`));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setErrors([...sizeErrors, ...files.map((file) => `${file.name}: ${message}`)]);
		} finally {
			pending.current = false;
			setImporting(false);
			callbacks.onFinish?.();
		}
	};
	return {
		errors, warnings, importing,
		onImportFiles: (files: FileList | null) => { if (files) void submit(Array.from(files)); },
	};
}

export function NotesImportErrors({ errors, warnings = [] }: { errors: readonly string[]; warnings?: readonly string[] }) {
	return <>
		{errors.map((error, i) => (
			<p key={i} role="alert" className="max-w-full whitespace-pre-wrap break-words text-xs text-red-400">{error}</p>
		))}
		{warnings.map((warning, i) => (
			<p key={`w${i}`} role="status" className="max-w-full whitespace-pre-wrap break-words text-xs text-amber-500">{warning}</p>
		))}
	</>;
}

/**
 * HANDWRITING READING (2026-11-01): a notebook page from a reMarkable (or
 * any handwritten PDF page) carries no text layer: its writing is pen
 * strokes. Gemini reads the rendered page into plain text, on the same
 * GEMINI_API_KEY the dictation and search engines ride. A few pages go in
 * one request (fewer requests count against the free tier's daily limit).
 *
 * The model: LH_GEMINI_HANDWRITING_MODEL, else gemini-flash-latest (on the
 * free tier each model has its own daily quota, so reading notes doesn't
 * eat into the teaching model's).
 */

import { keyValue } from "./keys.ts";
import { geminiErrorMessage } from "./search.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Pages per request: small enough that one bad answer costs little. */
export const PAGES_PER_REQUEST = 4;

export function handwritingModel(): string {
	return process.env.LH_GEMINI_HANDWRITING_MODEL || "gemini-flash-latest";
}

export function handwritingKey(): string | null {
	return keyValue("GEMINI_API_KEY") ?? null;
}

/** A refusal before anything was spent: no key to read handwriting with. */
export class HandwritingUnavailableError extends Error {
	constructor() {
		super("Reading handwriting needs a Gemini API key. Add one in Settings → Keys (the free tier is enough), then press Retry.");
	}
}

export function handwritingPrompt(pages: readonly number[]): string {
	return [
		`These are ${pages.length === 1 ? "one page" : `${pages.length} pages`} of a student's handwritten class notes (pages ${pages.join(", ")}, in order).`,
		"Transcribe each page faithfully, in the language it is written in. Do not translate, summarize, correct or add anything.",
		"Keep the structure: headings, lists, arrows (write →), boxed or underlined key points (write them on their own line).",
		"Write mathematics in LaTeX between $…$ (inline) or $$…$$ (display).",
		"For a drawing or diagram, write one line [Diagram: what it shows, with its labels].",
		"Write [illegible] for a word you cannot read. A page with no writing gets an empty text.",
		'Answer with JSON only: {"pages":[{"page":<page number>,"text":"<transcription>"}]} with one entry per page.',
	].join("\n");
}

export interface PageImage {
	page: number;
	png: Uint8Array;
}

/** Read up to PAGES_PER_REQUEST rendered pages. Returns page → text. */
export async function readHandwriting(
	images: readonly PageImage[],
	opts: { apiKey: string; fetchFn?: FetchLike; signal?: AbortSignal },
): Promise<Map<number, string>> {
	const fetchFn = opts.fetchFn ?? fetch;
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${handwritingModel()}:generateContent`;
	const resp = await fetchFn(url, {
		method: "POST",
		headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
		body: JSON.stringify({
			contents: [
				{
					role: "user",
					parts: [
						{ text: handwritingPrompt(images.map((i) => i.page)) },
						...images.map((i) => ({ inline_data: { mime_type: "image/png", data: Buffer.from(i.png).toString("base64") } })),
					],
				},
			],
			generationConfig: { temperature: 0, responseMimeType: "application/json" },
		}),
		signal: opts.signal ?? AbortSignal.timeout(180_000),
	});
	if (!resp.ok) {
		const status = resp.status;
		const message = await geminiErrorMessage(resp, "handwriting reading");
		throw new HandwritingRequestError(message, status);
	}
	const data = (await resp.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
	const raw = (data.candidates?.[0]?.content?.parts ?? [])
		.filter((p) => !p.thought && typeof p.text === "string")
		.map((p) => p.text)
		.join("")
		.trim();
	return parseHandwriting(raw, images.map((i) => i.page));
}

/** The model's JSON answer → page → text. Every asked page must be answered. */
export function parseHandwriting(raw: string, pages: readonly number[]): Map<number, string> {
	const body = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("Gemini's handwriting answer was not readable. Press Retry.");
	}
	const list = (parsed as { pages?: unknown })?.pages;
	if (!Array.isArray(list)) throw new Error("Gemini's handwriting answer was not readable. Press Retry.");
	const out = new Map<number, string>();
	for (const entry of list) {
		const { page, text } = (entry ?? {}) as { page?: unknown; text?: unknown };
		if (typeof page === "number" && typeof text === "string" && pages.includes(page)) out.set(page, text.trim());
	}
	// A single page answered under another number is still that page.
	if (out.size === 0 && pages.length === 1 && list.length === 1 && typeof (list[0] as { text?: unknown })?.text === "string") {
		out.set(pages[0]!, String((list[0] as { text: string }).text).trim());
	}
	const missing = pages.filter((p) => !out.has(p));
	if (missing.length > 0) throw new Error(`Gemini skipped page ${missing.join(", ")} of the handwriting. Press Retry.`);
	return out;
}

/** A refused request, with its HTTP status (429 = a rate or daily limit). */
export class HandwritingRequestError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
	/** The provider's own words (geminiErrorMessage adds its "reset daily" hint
	 *  to every 429, so only the part after the colon tells per-minute from per-day). */
	get detail(): string {
		const at = this.message.indexOf(": ");
		return at >= 0 ? this.message.slice(at + 2) : this.message;
	}
	get dailyQuota(): boolean {
		return this.status === 429 && /PerDay|per day|daily/i.test(this.detail);
	}
	get rateLimited(): boolean {
		return this.status === 429 && !this.dailyQuota;
	}
}

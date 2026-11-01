/**
 * PAGE FINGERPRINTS (2026-11-01, the watched notes folder): what makes a
 * page "the same page" across a renamed copy or a re-exported notebook.
 *
 * A PDF page's fingerprint hashes what pdfjs would draw: its operator list
 * (every path, stroke, text run and their numbers) with each image's decoded
 * pixels, and with pdfjs's per-page object names normalised, so the same
 * page at another position, or in another file, hashes the same. File-level
 * metadata (export date, producer, object numbering) never reaches the hash,
 * which is why a re-export of an unchanged page matches.
 *
 * A text file (.txt, .md) is split into paragraphs, each its own "page":
 * text added at the end is new, a changed paragraph is an edit.
 *
 * Everything here is local and free: no model call.
 */

import * as crypto from "node:crypto";
import { standardFontsDir } from "../agent/subagents/pdf-ops.ts";

export interface PrintedPage {
	fp: string;
	/** The page's text layer (lines kept). Empty for handwriting. */
	text: string;
	/** Needs eyes: little or no text layer, or drawn on (pen strokes over a typed page). */
	needsVision: boolean;
}

export function isPdfBytes(name: string, bytes: Uint8Array): boolean {
	return /\.pdf$/i.test(name) || (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-");
}

export function sha256(bytes: Uint8Array | string): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Path-drawing operations past which a page with a text layer counts as written on. */
const INK_PATHS = 60;
/** Under this many characters a text layer is a page number or a header, not notes. */
const MIN_TEXT = 20;

/** pdfjs names page objects after their page ("img_p3_1"): drop the page part. */
function normaliseName(v: string): string {
	return v.replace(/^(img|mask|pattern|g)_p\d+_/, "$1_");
}

function feed(hash: crypto.Hash, v: unknown, depth = 0): void {
	if (depth > 12) return;
	if (v === null || v === undefined) {
		hash.update("∅");
	} else if (typeof v === "number") {
		// Rounded: the same stroke must hash the same whatever float noise.
		hash.update(`n${Math.round(v * 1000) / 1000};`);
	} else if (typeof v === "string") {
		hash.update(`s${normaliseName(v)};`);
	} else if (typeof v === "boolean") {
		hash.update(v ? "T" : "F");
	} else if (ArrayBuffer.isView(v)) {
		const view = v as ArrayBufferView;
		if (view instanceof Float32Array || view instanceof Float64Array) {
			hash.update("f[");
			for (const x of view) hash.update(`${Math.round(x * 1000) / 1000},`);
			hash.update("]");
		} else {
			hash.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
		}
	} else if (Array.isArray(v)) {
		hash.update("[");
		for (const x of v) feed(hash, x, depth + 1);
		hash.update("]");
	} else if (typeof v === "object") {
		hash.update("{");
		for (const k of Object.keys(v as object).sort()) {
			hash.update(`${k}:`);
			feed(hash, (v as Record<string, unknown>)[k], depth + 1);
		}
		hash.update("}");
	} else {
		hash.update(String(v));
	}
}

function itemsToLines(items: unknown[]): string {
	let out = "";
	for (const it of items) {
		if (!it || typeof it !== "object") continue;
		const { str, hasEOL } = it as { str?: unknown; hasEOL?: unknown };
		if (typeof str === "string") out += str;
		if (hasEOL === true) out += "\n";
	}
	return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Every page of a PDF, fingerprinted, with its text layer. Throws on a file pdfjs cannot parse. */
export async function pdfPagePrints(bytes: Uint8Array): Promise<PrintedPage[]> {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: standardFontsDir(), verbosity: 0 });
	try {
		const doc = await task.promise;
		const out: PrintedPage[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const page = await doc.getPage(i);
			const ops = await page.getOperatorList();
			const hash = crypto.createHash("sha256");
			const [x0, y0, x1, y1] = page.view;
			feed(hash, [x1! - x0!, y1! - y0!, page.rotate]);
			let paths = 0;
			for (let k = 0; k < ops.fnArray.length; k++) {
				const fn = ops.fnArray[k]!;
				const args = ops.argsArray[k];
				hash.update(`o${fn}`);
				if (fn === pdfjs.OPS.constructPath) paths++;
				if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) {
					// The image's own pixels: two scans of the same size must not collide.
					const id = Array.isArray(args) ? args[0] : undefined;
					const img = typeof id === "string" ? imageData(page, id) : null;
					feed(hash, img ? [img.width, img.height] : args);
					if (img?.data) hash.update(img.data);
					continue;
				}
				feed(hash, args);
			}
			const text = itemsToLines((await page.getTextContent()).items as unknown[]);
			const hasText = text.replace(/\s+/g, "").length >= MIN_TEXT;
			out.push({ fp: `p_${hash.digest("hex").slice(0, 32)}`, text, needsVision: !hasText || paths >= INK_PATHS });
			page.cleanup();
		}
		return out;
	} finally {
		await task.destroy();
	}
}

type ImageLike = { width: number; height: number; data?: Uint8Array | Uint8ClampedArray };

function imageData(page: unknown, id: string): ImageLike | null {
	const p = page as { objs?: { has(id: string): boolean; get(id: string): unknown }; commonObjs?: { has(id: string): boolean; get(id: string): unknown } };
	for (const store of [p.objs, p.commonObjs]) {
		try {
			if (store?.has(id)) {
				const img = store.get(id) as ImageLike | null;
				if (img && typeof img.width === "number") return img;
			}
		} catch {
			/* not resolved: hash its arguments instead */
		}
	}
	return null;
}

/** A text file's "pages": its paragraphs. */
export function textPagePrints(text: string): PrintedPage[] {
	return text
		.replace(/\r\n?/g, "\n")
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => ({ fp: `t_${sha256(p.replace(/\s+/g, " ")).slice(0, 32)}`, text: p, needsVision: false }));
}

/**
 * POST /api/handwriting — read one captured page of the learner's writing
 * (the live reMarkable capture, 2026-11-08). Body: the PNG (image/png).
 * Answers {text}; text is "" when no writing was visible. The Gemini key is
 * read server-side and never returned.
 */
import { HandwritingRequestError, HandwritingUnavailableError, MAX_SKETCH_BYTES, handwritingKey, readSketch } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	const apiKey = handwritingKey();
	if (!apiKey) return Response.json({ message: new HandwritingUnavailableError().message }, { status: 503 });
	const png = new Uint8Array(await request.arrayBuffer());
	if (png.byteLength === 0) return Response.json({ text: "" });
	if (png.byteLength > MAX_SKETCH_BYTES) return Response.json({ message: "That capture is too large to read." }, { status: 413 });
	// PNG signature: refuse anything else before it goes to a provider.
	if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) return Response.json({ message: "Not a PNG image." }, { status: 415 });
	try {
		return Response.json({ text: await readSketch(png, { apiKey }) });
	} catch (e) {
		const status = e instanceof HandwritingRequestError && e.status === 429 ? 429 : 502;
		return Response.json({ message: e instanceof Error ? e.message : "Gemini unreachable" }, { status });
	}
}

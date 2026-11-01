import { readingQueueState } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/reading-queue — files the AI is reading or adding to the map. */
export async function GET() {
	return Response.json(readingQueueState());
}

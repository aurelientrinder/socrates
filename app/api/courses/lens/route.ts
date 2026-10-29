import { courseLens } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/courses/lens — the classes that own sessions, with their colors, for the map and other screens. */
export async function GET() {
	return Response.json({ classes: courseLens() });
}

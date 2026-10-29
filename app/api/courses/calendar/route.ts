import { courseCalendar } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/courses/calendar[?refresh=1] — the eight weeks of calendar events,
 *  each filed, ignored or unplaced, with the groups to file them in. */
export async function GET(req: Request) {
	const refresh = new URL(req.url).searchParams.get("refresh") === "1";
	return Response.json(await courseCalendar({ refresh }));
}

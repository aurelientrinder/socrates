import { CourseError, createCourse, listCourses, savedBriefing } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/courses — the course groups and the calendar's suggestions
 *  (from the events today's briefing read; no calendar call here). */
export async function GET() {
	return Response.json(listCourses(savedBriefing()?.events ?? []));
}

/** POST /api/courses — make a group: { label, key? } (key = a suggestion's). */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { label?: unknown; key?: unknown };
	try {
		const { key } = createCourse(body);
		return Response.json({ key, ...listCourses(savedBriefing()?.events ?? []) });
	} catch (err) {
		if (err instanceof CourseError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

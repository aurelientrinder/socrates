import { CourseError, dismissCourseSuggestion, listCourses, savedBriefing } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/courses/dismiss — { key }: "not a class", stop suggesting it. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { key?: unknown };
	try {
		dismissCourseSuggestion(typeof body.key === "string" ? body.key : "");
		return Response.json(listCourses(savedBriefing()?.events ?? []));
	} catch (err) {
		if (err instanceof CourseError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

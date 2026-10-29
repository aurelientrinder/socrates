import type { MergeRestore } from "@/src/core";
import { CourseError, courseCalendar, unmergeCourses } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/courses/unmerge — { restore }: put two merged courses back as they were. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { restore?: unknown };
	try {
		unmergeCourses(body.restore as MergeRestore);
		return Response.json({ calendar: await courseCalendar() });
	} catch (err) {
		if (err instanceof CourseError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

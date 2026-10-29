import { CourseError, courseCalendar, mergeCourses } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/courses/merge — { from, into }: fold course `from` into `into`.
 * Answers with `restore` (hand it to /api/courses/unmerge to undo) and the
 * calendar as it reads now.
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { from?: unknown; into?: unknown };
	try {
		if (typeof body.from !== "string" || typeof body.into !== "string") throw new CourseError("Pick the two courses to merge.");
		const { restore } = mergeCourses(body.from, body.into);
		return Response.json({ restore, calendar: await courseCalendar() });
	} catch (err) {
		if (err instanceof CourseError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

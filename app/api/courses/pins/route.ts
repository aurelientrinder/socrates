import { CourseError, courseCalendar, setCoursePins, type PinChange } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * PUT /api/courses/pins — { changes: [{ scope: "event" | "title", id, value }] }:
 * file events by hand. `id` is an event id or a titleKey; `value` a group
 * key, "~ignored" (not a class) or null (clear). Answers with the calendar
 * and `undo`, the same changes with their previous values.
 */
export async function PUT(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { changes?: unknown };
	if (!Array.isArray(body.changes) || body.changes.length === 0 || body.changes.length > 500) {
		return Response.json({ error: "changes must be a list of 1 to 500 pins." }, { status: 400 });
	}
	try {
		const { undo } = setCoursePins(body.changes as PinChange[]);
		return Response.json({ undo, calendar: await courseCalendar() });
	} catch (err) {
		if (err instanceof CourseError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

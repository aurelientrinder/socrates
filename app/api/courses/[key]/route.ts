import { CourseError, deleteCourse, listCourses, savedBriefing, updateCourse } from "@/src/server";

export const dynamic = "force-dynamic";

/** The key as stored (course keys hold spaces and accents). */
function keyOf(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

/** PATCH /api/courses/[key] — { label?, addNoteIds?, removeNoteIds?, chatIds?, addAlias? }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		updateCourse(keyOf(key), body);
		return Response.json(listCourses(savedBriefing()?.events ?? []));
	} catch (err) {
		if (err instanceof CourseError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

/** DELETE /api/courses/[key] — remove the group (notes and sessions stay). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ key: string }> }) {
	const { key } = await params;
	try {
		deleteCourse(keyOf(key));
		return Response.json(listCourses(savedBriefing()?.events ?? []));
	} catch (err) {
		if (err instanceof CourseError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

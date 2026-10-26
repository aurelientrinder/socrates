import { readCourseLinks, setCourseLink } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ links: readCourseLinks() });
}

/** Confirm which sessions belong to a course: { key, label, chatIds }. */
export async function PUT(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { key?: unknown; label?: unknown; chatIds?: unknown };
	if (
		typeof body.key !== "string" ||
		!body.key ||
		body.key.length > 200 ||
		typeof body.label !== "string" ||
		!Array.isArray(body.chatIds) ||
		!body.chatIds.every((id) => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id))
	) {
		return Response.json({ error: "Body must be { key, label, chatIds: string[] }" }, { status: 400 });
	}
	return Response.json({ links: setCourseLink(body.key, body.label.slice(0, 200), body.chatIds as string[]) });
}

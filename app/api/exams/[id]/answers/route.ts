import { ExamError, saveExamAnswers } from "@/src/server";

export const dynamic = "force-dynamic";

/** PUT /api/exams/[id]/answers {answers: {partId: {...}}} — autosave while
 *  the clock runs. 409 once the exam is closed. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let body: { answers?: unknown };
	try {
		body = (await req.json()) as { answers?: unknown };
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	try {
		return Response.json(saveExamAnswers(id, body.answers));
	} catch (err) {
		if (err instanceof ExamError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

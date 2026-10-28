import { deleteExam, getExamView } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/exams/[id] — the exam as the learner may see it (no hidden
 *  solutions before it is graded). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const view = getExamView(id);
	if (!view) return Response.json({ error: "Exam not found." }, { status: 404 });
	return Response.json(view);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!deleteExam(id)) return Response.json({ error: "Exam not found." }, { status: 404 });
	return Response.json({ ok: true });
}

import { ExamError, submitExam } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/exams/[id]/submit {answers?, timedOut?} — hand the paper in;
 *  grading starts in the background. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = (await req.json().catch(() => ({}))) as { answers?: unknown; timedOut?: unknown };
	try {
		return Response.json(submitExam(id, body));
	} catch (err) {
		if (err instanceof ExamError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

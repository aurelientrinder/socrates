import { ExamError, retryExam } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/exams/[id]/retry — after a failure: write the exam again, or
 *  finish grading it. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		return Response.json(retryExam(id));
	} catch (err) {
		if (err instanceof ExamError) return Response.json(err.body ?? { error: err.message }, { status: err.status });
		throw err;
	}
}

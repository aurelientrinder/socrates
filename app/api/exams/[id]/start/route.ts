import { beginExam, ExamError } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/exams/[id]/start — open the paper: the clock starts now. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		return Response.json(beginExam(id));
	} catch (err) {
		if (err instanceof ExamError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

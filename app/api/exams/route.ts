import { ExamError, listExams, startExam } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/exams — every mock exam, newest first (the Library list). */
export async function GET() {
	return Response.json({ exams: listExams() });
}

/** POST /api/exams {scope, noteIds, minutes} — start writing a mock exam
 *  in the background. 503 when no model can run it. */
export async function POST(req: Request) {
	let body: Record<string, unknown>;
	try {
		body = (await req.json()) as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	try {
		return Response.json(startExam(body));
	} catch (err) {
		if (err instanceof ExamError) return Response.json(err.body ?? { error: err.message }, { status: err.status });
		throw err;
	}
}

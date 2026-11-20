import { fitPersonalFsrs, fsrsModelStatus, resetPersonalFsrs } from "@/src/server";

export const dynamic = "force-dynamic";

/** Personal FSRS-6 model status: default vs. personalized weights, review count, metrics. */
export async function GET() {
	return Response.json(fsrsModelStatus());
}

/** Fit personal FSRS-6 weights to the learner's unified recall history. */
export async function POST() {
	const result = fitPersonalFsrs();
	if (!result.fit) {
		return Response.json(
			{ error: `Need at least ${result.status.minReviews} follow-up reviews to fit personal weights (have ${result.status.reviews}).`, status: result.status },
			{ status: 400 },
		);
	}
	return Response.json(result);
}

/** Reset personal FSRS-6 weights back to published FSRS-6 defaults. */
export async function DELETE() {
	return Response.json(resetPersonalFsrs());
}

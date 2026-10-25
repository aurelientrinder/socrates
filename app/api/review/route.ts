import { retentionAcrossSessions } from "@/src/server";

export const dynamic = "force-dynamic";

/** The sidebar's due badge: how many topics have decayed under the target. */
export async function GET() {
	const report = retentionAcrossSessions();
	return Response.json({ due: report.due.length, tracked: report.topics.length });
}

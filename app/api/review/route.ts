import { CALIBRATED_WITHIN, CALIBRATION_MIN_ANSWERS } from "@/src/core";
import { calibrationAcrossSessions, retentionAcrossSessions } from "@/src/server";

export const dynamic = "force-dynamic";

/** The sidebar's due badge: how many topics have decayed under the target.
 *  Also the honesty gap (points surer than the answers show), when the
 *  answers show clear overconfidence: the start dialog says so beside the
 *  warm-up, where it changes what you do (same rule as Today). */
export async function GET() {
	const report = retentionAcrossSessions();
	const calibration = calibrationAcrossSessions();
	const gap = calibration.gap;
	const honesty = gap !== null && calibration.answered >= CALIBRATION_MIN_ANSWERS && gap > CALIBRATED_WITHIN ? { points: Math.round(gap) } : null;
	return Response.json({ due: report.due.length, tracked: report.topics.length, honesty });
}

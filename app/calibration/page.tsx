import { CalibrationView } from "@/components/calibration-view";
import { calibrationAcrossSessions } from "@/src/server";

// Dynamic: every visit re-reads the session records, so the view always
// carries the answers given since the last look.
export const dynamic = "force-dynamic";

export default function CalibrationPage() {
	return <CalibrationView report={calibrationAcrossSessions()} />;
}

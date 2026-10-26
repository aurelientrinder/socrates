import { redirect } from "next/navigation";

// The Calibration page is a tab of Progress now (redesign wave).
export default function CalibrationPage() {
	redirect("/progress?tab=calibration");
}

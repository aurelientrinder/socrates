import { CalibrationView } from "@/components/calibration-view";
import { PageFrame, PageTabs, PROGRESS_TABS } from "@/components/page-header";
import { ReviewView } from "@/components/review-view";
import { calibrationAcrossSessions, retentionAcrossSessions, reviewStatus } from "@/src/server";

// Dynamic: retention decays with the clock and every visit re-reads the
// session records, so both tabs are always as of now.
export const dynamic = "force-dynamic";

/**
 * PROGRESS (redesign wave, 2026-10-26): how you are doing, in one place.
 * Memory is the old Review page (what is fading, the Start review panel),
 * Calibration the old Calibration page (how sure you felt vs how right you
 * were). The Map tab links to the knowledge map at /map. /review and
 * /calibration redirect here.
 */
export default async function ProgressPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
	const { tab } = await searchParams;
	const active = tab === "calibration" ? "calibration" : "memory";
	const now = Date.now();
	return (
		<PageFrame title="Progress" testId="progress-page">
			<PageTabs tabs={PROGRESS_TABS} active={active} />
			{active === "calibration" ? (
				<CalibrationView report={calibrationAcrossSessions()} />
			) : (
				<ReviewView report={retentionAcrossSessions(now)} status={reviewStatus(now)} />
			)}
		</PageFrame>
	);
}

import { CalibrationView } from "@/components/calibration-view";
import { FlashcardReview } from "@/components/flashcard-review";
import { PageFrame, PageTabs, PROGRESS_TABS } from "@/components/page-header";
import { ReviewView } from "@/components/review-view";
import { WeakSpotsView } from "@/components/weak-spots-view";
import { calibrationAcrossSessions, courseLens, retentionAcrossSessions, reviewStatus, weakSpotsAcrossSessions } from "@/src/server";

// Dynamic: retention decays with the clock and every visit re-reads the
// session records, so both tabs are always as of now.
export const dynamic = "force-dynamic";

/**
 * PROGRESS (redesign wave, 2026-10-26): how you are doing, in one place.
 * Memory is the old Review page (what is fading, the Start review panel),
 * Calibration the old Calibration page (how sure you felt vs how right you
 * were), Weak spots joins the two per topic (where you were surer than
 * right, or only just recalled) with a Drill button, Flashcards the cards
 * made from imported notes (2026-10-27). The Map tab links to the
 * knowledge map at /map. /review and /calibration redirect here.
 */
export default async function ProgressPage({ searchParams }: { searchParams: Promise<{ tab?: string; deck?: string }> }) {
	const { tab, deck } = await searchParams;
	const active = tab === "calibration" || tab === "weak-spots" || tab === "cards" ? tab : "memory";
	const now = Date.now();
	return (
		<PageFrame title="Progress" testId="progress-page">
			<PageTabs tabs={PROGRESS_TABS} active={active} />
			{active === "calibration" ? (
				<CalibrationView report={calibrationAcrossSessions()} />
			) : active === "weak-spots" ? (
				<WeakSpotsView report={weakSpotsAcrossSessions(now)} />
			) : active === "cards" ? (
				<FlashcardReview key={deck ?? "all"} deck={deck} />
			) : (
				<ReviewView report={retentionAcrossSessions(now)} status={reviewStatus(now)} classes={courseLens()} />
			)}
		</PageFrame>
	);
}

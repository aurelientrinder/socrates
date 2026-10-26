import { TodayView } from "@/components/today-view";
import { CALIBRATED_WITHIN } from "@/src/core";
import {
	calibrationAcrossSessions,
	googleCalendarStatus,
	listChats,
	readBriefingPrefs,
	savedBriefing,
	TASK_PROVIDERS,
} from "@/src/server";

// Dynamic: the briefing is per day and the connections change under it.
export const dynamic = "force-dynamic";

/** Rated answers needed before Today calls out overconfidence. */
const HONESTY_MIN_ANSWERS = 5;

/**
 * HOME = TODAY (redesign wave, 2026-10-26): opening the app answers "what
 * should I do right now?". The knowledge map that used to be the home
 * lives at /map (Progress → Map); /today redirects here.
 */
export default function TodayPage() {
	const calibration = calibrationAcrossSessions();
	const gap = calibration.gap;
	const honesty =
		gap !== null && calibration.answered >= HONESTY_MIN_ANSWERS && gap > CALIBRATED_WITHIN ? { points: Math.round(gap) } : null;
	return (
		<TodayView
			initialBriefing={savedBriefing()}
			initialIntegrations={{
				google: googleCalendarStatus(),
				todo: TASK_PROVIDERS.map((p) => ({ id: p.id, label: p.label, configured: p.configured() })),
			}}
			initialBudget={readBriefingPrefs().budgetMinutes}
			sessions={listChats().map((c) => ({ id: c.id, title: c.title }))}
			honesty={honesty}
		/>
	);
}

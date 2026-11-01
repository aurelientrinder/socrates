import { TodayView } from "@/components/today-view";
import { CALIBRATED_WITHIN, CALIBRATION_MIN_ANSWERS } from "@/src/core";
import {
	backupIfDue,
	calibrationAcrossSessions,
	googleCalendarStatus,
	listChats,
	readBriefingPrefs,
	savedBriefing,
	settingsRecovery,
	settingsStore,
	studyRecord,
	TASK_PROVIDERS,
} from "@/src/server";

// Dynamic: the briefing is per day and the connections change under it.
export const dynamic = "force-dynamic";


/**
 * HOME = TODAY (redesign wave, 2026-10-26): opening the app answers "what
 * should I do right now?". The knowledge map that used to be the home
 * lives at /map (Progress → Map); /today redirects here.
 */
export default function TodayPage() {
	settingsStore.readSettings(); // a damaged file is recovered (and noted) here
	const recovery = settingsRecovery();
	backupIfDue();
	const calibration = calibrationAcrossSessions();
	const gap = calibration.gap;
	const honesty =
		gap !== null && calibration.answered >= CALIBRATION_MIN_ANSWERS && gap > CALIBRATED_WITHIN ? { points: Math.round(gap) } : null;
	const now = new Date();
	const study = studyRecord(now);
	const week = { minutes: study.week, today: (now.getDay() + 6) % 7 };
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
			week={week}
			streak={study.streak}
			settingsRecovery={recovery && { keptAs: recovery.keptAs, restoredFrom: recovery.restoredFrom }}
		/>
	);
}

import { TodayView } from "@/components/today-view";
import { googleCalendarStatus, listChats, readBriefingPrefs, savedBriefing, TASK_PROVIDERS } from "@/src/server";

// Dynamic: the briefing is per day and the connections change under it.
export const dynamic = "force-dynamic";

export default function TodayPage() {
	return (
		<TodayView
			initialBriefing={savedBriefing()}
			initialIntegrations={{
				google: googleCalendarStatus(),
				todo: TASK_PROVIDERS.map((p) => ({ id: p.id, label: p.label, configured: p.configured() })),
			}}
			initialBudget={readBriefingPrefs().budgetMinutes}
			sessions={listChats().map((c) => ({ id: c.id, title: c.title }))}
		/>
	);
}

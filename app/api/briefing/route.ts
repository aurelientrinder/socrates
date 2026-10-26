import { getBriefing, googleCalendarStatus, readBriefingPrefs, savedBriefing, TASK_PROVIDERS } from "@/src/server";

export const dynamic = "force-dynamic";

function integrations() {
	return {
		google: googleCalendarStatus(),
		todo: TASK_PROVIDERS.map((p) => ({ id: p.id, label: p.label, configured: p.configured() })),
	};
}

/** Today's saved briefing (null before the first generation) + connection state. */
export async function GET() {
	return Response.json({ briefing: savedBriefing(), integrations: integrations(), prefs: readBriefingPrefs() });
}

/** Generate today's briefing if missing; { refresh: true } regenerates it. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { refresh?: unknown };
	try {
		const briefing = await getBriefing({ refresh: body.refresh === true });
		return Response.json({ briefing, integrations: integrations(), prefs: readBriefingPrefs() });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Could not build the briefing." }, { status: 500 });
	}
}

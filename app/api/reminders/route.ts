import { getBriefing, readReminderStatus, syncReminders, writeReminderPrefs } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(readReminderStatus());
}

/** { enabled?, hour?, sync? }: save the settings; sync (or any change) updates the calendar now. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { enabled?: unknown; hour?: unknown; sync?: unknown };
	const saved = writeReminderPrefs(body);
	if (!saved) return Response.json({ error: "Pick one of the offered reminder times." }, { status: 400 });
	if (body.sync !== true && body.enabled === undefined && body.hour === undefined) return Response.json(saved);
	try {
		const briefing = await getBriefing();
		return Response.json(await syncReminders(briefing.plan));
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Could not sync reminders." }, { status: 502 });
	}
}

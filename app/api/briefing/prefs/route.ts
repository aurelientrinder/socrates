import { BUDGET_CHOICES } from "@/src/core";
import { writeBriefingPrefs } from "@/src/server";

export const dynamic = "force-dynamic";

/** { budgetMinutes } — one of BUDGET_CHOICES. Applies from the next refresh. */
export async function PUT(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { budgetMinutes?: unknown };
	const saved = typeof body.budgetMinutes === "number" ? writeBriefingPrefs({ budgetMinutes: body.budgetMinutes }) : null;
	if (!saved) return Response.json({ error: `budgetMinutes must be one of ${BUDGET_CHOICES.join(", ")}` }, { status: 400 });
	return Response.json({ prefs: saved });
}

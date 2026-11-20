import { buildStudyFlowPlan, type LhMessage } from "@/src/core";
import {
	createChat,
	diagnosticContextMessage,
	getBriefing,
	readSettingsRecord,
	retentionAcrossSessions,
	stores,
	titleFromPrompt,
	warmupContextMessage,
	weakSpotsAcrossSessions,
} from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/flow — build a personalized 3-stage Study Flow (Warm-up → Learn →
 *  Practice), open its Stage 1+2 Learn session with warm-up + diagnostic
 *  hotspots, and return `{ plan, chatId, href }`. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { budgetMinutes?: unknown; topic?: unknown };
	const budgetMinutes = typeof body.budgetMinutes === "number" ? body.budgetMinutes : undefined;
	const topicOverride = typeof body.topic === "string" ? body.topic : undefined;
	const now = Date.now();

	const [briefing, retention, weakSpots] = await Promise.all([
		getBriefing({ now }).catch(() => null),
		Promise.resolve(retentionAcrossSessions(now)),
		Promise.resolve(weakSpotsAcrossSessions(now)),
	]);

	const plan = buildStudyFlowPlan({
		budgetMinutes,
		topicOverride,
		briefingItems: briefing?.plan.items ?? [],
		retention,
		weakSpots,
		now,
	});

	const chat = createChat(titleFromPrompt(`Flow: ${plan.topic}`));
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}

	const opening: LhMessage[] = [];
	const diagnostic = diagnosticContextMessage({ topic: plan.topic, now });
	if (diagnostic) opening.push(diagnostic);
	if (plan.hasWarmup) {
		const warmup = warmupContextMessage(now);
		if (warmup) opening.push(warmup);
	}
	if (opening.length > 0) stores.chatStore.saveMessages(chat.id, opening);

	const params = new URLSearchParams({ prompt: plan.learnPrompt });
	if (plan.noteId) params.set("note", plan.noteId);
	return Response.json({
		plan,
		chatId: chat.id,
		href: `/chat/${chat.id}?${params.toString()}`,
	});
}

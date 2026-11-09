/**
 * THE CLASS PAGE (QoL pass, 2026-11-08): everything about one class on one
 * screen: its next exam and how ready you are, what you know of it, its
 * plan this week, its sessions, notes and classes this week. Read-only: it
 * is assembled from today's saved briefing, the class links and the
 * retention report.
 */
import {
	classifyEvent,
	colorsFor,
	courseGroupFor,
	courseKeyOfEvent,
	type BriefingItem,
	type ChatListItem,
	type ClassPageData,
	type StudyEvent,
} from "../core/index.ts";
import { savedBriefing } from "./briefing.ts";
import { listChats, retentionAcrossSessions } from "./chats.ts";
import { courseMaterial, listCourses, readCourseLinks } from "./courses.ts";

const DAY = 24 * 60 * 60 * 1000;


/** Null when no class has this key. */
export function classPage(key: string, now: number = Date.now()): ClassPageData | null {
	const links = readCourseLinks();
	const group = links[key];
	if (!group) return null;
	const briefing = savedBriefing();
	const events: StudyEvent[] = briefing?.events ?? [];
	const course = listCourses(events, now).courses.find((c) => c.key === key);
	const color = colorsFor(Object.keys(links)).get(key) ?? 0;
	const plan = briefing?.plan;

	// Its events: those whose course resolves to this group.
	const mine = events.filter((e) => !e.ignored && courseGroupFor(links, courseKeyOfEvent(e))?.key === key);
	const eventIds = new Set(mine.map((e) => e.id));

	// Its sessions: the confirmed ones, plus the ones the plan linked to its events.
	const sessionIds = new Set(group.chatIds ?? []);
	for (const u of plan?.upcoming ?? []) if (eventIds.has(u.event.id)) for (const id of u.chatIds) sessionIds.add(id);
	const sessions = listChats()
		.filter((c) => sessionIds.has(c.id))
		.map((c): ChatListItem => ({ ...c, busy: false, compacting: false }));

	// Its topics: learned in its sessions or from its notes.
	const material = courseMaterial(links)[key];
	const noteTopics = new Set(material?.topicKeys ?? []);
	const all = retentionAcrossSessions(now).topics;
	const topics = all.filter((t) => sessionIds.has(t.chatId) || noteTopics.has(t.key));
	const topicKeys = new Set(topics.map((t) => t.key));

	const isMine = (item: BriefingItem) =>
		(item.eventId !== undefined && eventIds.has(item.eventId)) ||
		(item.chatId !== undefined && sessionIds.has(item.chatId)) ||
		item.topicKeys.some((k) => topicKeys.has(k));

	const days = plan?.study?.days ?? (plan ? [{ date: plan.day, items: plan.items, minutes: 0 }] : []);
	const planned = days.flatMap((d) => d.items.filter(isMine).map((item) => ({ date: d.date, item }))).slice(0, 8);

	const upcomingExam = mine
		.map((e) => ({ e, kind: e.kind ?? classifyEvent(e.title, e.source) }))
		.filter(({ e, kind }) => (kind === "exam" || kind === "deadline") && e.end >= now)
		.sort((a, b) => a.e.start - b.e.start)[0];
	const exam = upcomingExam
		? {
				title: upcomingExam.e.title,
				start: upcomingExam.e.start,
				kind: upcomingExam.kind as "exam" | "deadline",
				plan: plan?.study?.exams.find((x) => x.eventId === upcomingExam.e.id) ?? null,
			}
		: null;

	const tough = new Set((plan?.study?.tough ?? []).map((t) => t.key));
	const classes = mine
		.filter((e) => (e.kind ?? classifyEvent(e.title, e.source)) === "class" && e.end >= now && e.start < now + 7 * DAY)
		.sort((a, b) => a.start - b.start)
		.slice(0, 6)
		.map((e) => ({ title: e.title, start: e.start, tough: tough.has(key) }));

	return {
		key,
		label: group.label,
		color,
		notes: (course?.notes ?? []).map((n) => ({ id: n.id, name: n.name })),
		sessions,
		exam,
		topics: topics.slice(0, 8).map((t) => ({ key: t.key, title: t.title, retention: t.retention, due: t.due })),
		plan: planned,
		classes,
		next: course?.next ?? null,
	};
}

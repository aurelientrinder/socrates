/** The class page's data (QoL pass, 2026-11-08), built by src/server/class-page.ts. */
import type { BriefingItem } from "./briefing.ts";
import type { ChatListItem } from "./contracts/chat.ts";
import type { TopicRetention } from "./retention.ts";
import type { ExamPlan } from "./study-plan.ts";

export interface ClassPageData {
	key: string;
	label: string;
	color: number;
	notes: { id: string; name: string }[];
	sessions: ChatListItem[];
	/** The next exam or deadline of the class, with its plan verdict when planned. */
	exam: { title: string; start: number; kind: "exam" | "deadline"; plan: ExamPlan | null } | null;
	/** The class's tracked topics, weakest first. */
	topics: Pick<TopicRetention, "key" | "title" | "retention" | "due">[];
	/** The class's steps in the plan, today first. */
	plan: { date: string; item: BriefingItem }[];
	/** Its classes in the next seven days. */
	classes: { title: string; start: number; tough: boolean }[];
	next: { title: string; start: number; kind: string } | null;
}

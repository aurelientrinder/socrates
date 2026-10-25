/**
 * TODOIST — the first to-do provider for the daily briefing.
 *
 * Auth is the learner's personal API token (Settings → Keys,
 * TODOIST_API_TOKEN; the free plan has API access). Reads: active tasks
 * with a due date inside the briefing horizon, which become "deadline"
 * study events. Writes: one task per click on "Add to to-do", in the
 * Inbox (no project is created: the free plan caps projects).
 *
 * The provider shape (TaskProvider) is what a second app (Google Tasks,
 * Microsoft To Do) would implement.
 */

import type { StudyEvent } from "../../core/briefing.ts";
import { keyValue } from "../keys.ts";

const API = "https://api.todoist.com/api/v1";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;

export interface TaskProvider {
	id: string;
	label: string;
	configured(): boolean;
	listDatedTasks(from: number, to: number): Promise<StudyEvent[]>;
	addTask(input: { content: string; description: string; dueString?: string }): Promise<{ url?: string }>;
}

interface TodoistDue {
	date?: string;
	datetime?: string;
	is_recurring?: boolean;
}

interface TodoistTask {
	id: string;
	content?: string;
	due?: TodoistDue | null;
	checked?: boolean;
	is_deleted?: boolean;
}

function token(): string | undefined {
	return keyValue("TODOIST_API_TOKEN")?.trim() || undefined;
}

/** "2026-11-03" → local end of that day (a task due that day is due by its end);
 *  "2026-11-03T14:00:00[Z]" → that moment. */
export function todoistDueAt(due: TodoistDue | null | undefined): { at: number; allDay: boolean } | null {
	if (!due) return null;
	const value = due.datetime ?? due.date;
	if (!value) return null;
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const [y, m, d] = value.split("-").map(Number);
		return { at: new Date(y!, m! - 1, d!, 23, 59).getTime(), allDay: true };
	}
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? { at: ms, allDay: false } : null;
}

export function todoistToStudyEvent(task: TodoistTask): StudyEvent | null {
	if (task.checked || task.is_deleted || !task.content) return null;
	const due = todoistDueAt(task.due);
	if (!due) return null;
	return {
		id: `todoist:${task.id}`,
		title: task.content,
		start: due.at,
		end: due.at,
		allDay: due.allDay,
		source: "todo",
		url: `https://app.todoist.com/app/task/${encodeURIComponent(task.id)}`,
	};
}

async function call<T>(pathAndQuery: string, init?: { method?: string; body?: unknown }): Promise<T> {
	const t = token();
	if (!t) throw new Error("Add your Todoist API token in Settings → Keys first.");
	const res = await fetch(`${API}${pathAndQuery}`, {
		method: init?.method ?? "GET",
		headers: {
			Authorization: `Bearer ${t}`,
			...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (res.status === 401 || res.status === 403) throw new Error("Todoist rejected the API token. Check it in Settings → Keys.");
	if (!res.ok) throw new Error(`Todoist request failed (${res.status}).`);
	return (await res.json()) as T;
}

export const todoist: TaskProvider = {
	id: "todoist",
	label: "Todoist",
	configured: () => token() !== undefined,
	async listDatedTasks(from, to) {
		const out: StudyEvent[] = [];
		let cursor: string | null = null;
		for (let page = 0; page < MAX_PAGES; page++) {
			const query: URLSearchParams = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
			const body: { results?: TodoistTask[]; next_cursor?: string | null } = await call<{ results?: TodoistTask[]; next_cursor?: string | null }>(`/tasks?${query}`);
			for (const task of body.results ?? []) {
				const ev = todoistToStudyEvent(task);
				// Overdue tasks count as due now: they are still owed.
				if (ev && ev.start <= to) out.push(ev.start < from ? { ...ev, start: from, end: from } : ev);
			}
			cursor = body.next_cursor ?? null;
			if (!cursor) break;
		}
		return out;
	},
	async addTask(input) {
		const task = await call<{ id?: string; url?: string }>("/tasks", {
			method: "POST",
			body: { content: input.content, description: input.description, ...(input.dueString ? { due_string: input.dueString } : {}) },
		});
		return task.url ? { url: task.url } : task.id ? { url: `https://app.todoist.com/app/task/${encodeURIComponent(task.id)}` } : {};
	},
};

/** The configured to-do providers (one today; the seam for more). */
export const TASK_PROVIDERS: readonly TaskProvider[] = [todoist];

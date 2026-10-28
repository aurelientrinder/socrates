/**
 * REMINDER ALERTS: writes the gentle pings from core/reminders.ts as
 * five-minute events on the learner's "Socrates" Google calendar, each with
 * a popup alert at its start. Google delivers those to the phone and the
 * laptop even while the app is closed. The app only has to run now and then
 * to refresh them (it syncs whenever the daily briefing is built).
 *
 * Only events this module made are touched (a private marker), and only
 * on the "Socrates" calendar the app made for itself (google-calendar.ts);
 * nothing lands on the primary calendar.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { buildReminders, DEFAULT_REMINDER_HOUR, REMINDER_HOUR_CHOICES, REMINDER_DAYS, type Reminder, type ReminderPrefs } from "../core/reminders.ts";
import type { BriefingPlan } from "../core/briefing.ts";
import { api, googleCalendarStatus, socratesCalendarId } from "./integrations/google-calendar.ts";

const DIR = path.join(PATHS.data, "briefing");
const PREFS_FILE = path.join(DIR, "reminders.json");
const MARKER = "socratesReminder=1";
const EVENT_MINUTES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReminderStatus {
	prefs: ReminderPrefs;
	/** Last successful sync, epoch ms. */
	syncedAt?: number;
	/** Reminders on the calendar after the last sync. */
	scheduled?: number;
	error?: string;
}

function readStatus(): ReminderStatus {
	let raw: Partial<ReminderStatus> | null = null;
	try {
		raw = JSON.parse(fs.readFileSync(PREFS_FILE, "utf-8"));
	} catch {
		raw = null;
	}
	const hour = raw?.prefs?.hour;
	return {
		prefs: {
			enabled: raw?.prefs?.enabled === true,
			hour: typeof hour === "number" && (REMINDER_HOUR_CHOICES as readonly number[]).includes(hour) ? hour : DEFAULT_REMINDER_HOUR,
		},
		...(typeof raw?.syncedAt === "number" ? { syncedAt: raw.syncedAt } : {}),
		...(typeof raw?.scheduled === "number" ? { scheduled: raw.scheduled } : {}),
		...(typeof raw?.error === "string" ? { error: raw.error } : {}),
	};
}

function writeStatus(status: ReminderStatus): void {
	fs.mkdirSync(DIR, { recursive: true });
	const tmp = `${PREFS_FILE}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(status, null, "\t")}\n`);
	fs.renameSync(tmp, PREFS_FILE);
}

export const readReminderStatus = readStatus;

export function writeReminderPrefs(input: { enabled?: unknown; hour?: unknown }): ReminderStatus | null {
	const current = readStatus();
	const enabled = input.enabled === undefined ? current.prefs.enabled : input.enabled === true;
	const hour = input.hour === undefined ? current.prefs.hour : input.hour;
	if (typeof hour !== "number" || !(REMINDER_HOUR_CHOICES as readonly number[]).includes(hour)) return null;
	const next = { ...current, prefs: { enabled, hour } };
	writeStatus(next);
	return next;
}

/** Google event ids take a-v and 0-9 (5-1024 chars); hex qualifies. */
const eventId = (key: string) => `soc${createHash("sha1").update(key).digest("hex")}`;

interface ReminderEvent {
	id: string;
	start?: { dateTime?: string };
	summary?: string;
}

function eventBody(r: Reminder) {
	return {
		summary: r.title,
		description: `${r.body}\n\nSent by Socrates.`,
		start: { dateTime: new Date(r.start).toISOString() },
		end: { dateTime: new Date(r.start + EVENT_MINUTES * 60_000).toISOString() },
		transparency: "transparent",
		reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
		extendedProperties: { private: { socratesReminder: "1" } },
	};
}

/**
 * Make the Socrates calendar's reminders match `plan`: add new ones, update
 * moved ones, remove the ones no longer wanted. Records the outcome.
 */
export async function syncReminders(plan: BriefingPlan, now: number = Date.now()): Promise<ReminderStatus> {
	const status = readStatus();
	const { enabled } = status.prefs;
	if (!enabled && status.scheduled === undefined) return status;
	if (!googleCalendarStatus().connected) {
		const next = { ...status, error: "Connect Google Calendar first." };
		writeStatus(next);
		return next;
	}
	try {
		const calendarId = await socratesCalendarId();
		const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
		const wanted = new Map(buildReminders(plan, status.prefs, now).map((r) => [eventId(r.key), r]));
		const query = new URLSearchParams({
			timeMin: new Date(now - DAY_MS).toISOString(),
			timeMax: new Date(now + (REMINDER_DAYS + 40) * DAY_MS).toISOString(),
			singleEvents: "true",
			privateExtendedProperty: MARKER,
			maxResults: "250",
		});
		const existing = (await api<{ items?: ReminderEvent[] }>(`${base}?${query}`)).items ?? [];
		for (const e of existing) {
			if (!wanted.has(e.id)) await api(`${base}/${e.id}`, { method: "DELETE" }).catch((err: { status?: number }) => {
				if (err.status !== 404 && err.status !== 410) throw err;
			});
		}
		for (const [id, r] of wanted) {
			try {
				await api(base, { method: "POST", body: { id, ...eventBody(r) } });
			} catch (err) {
				// 409: it exists already (maybe cancelled earlier); update it in place.
				if ((err as { status?: number }).status !== 409) throw err;
				await api(`${base}/${id}`, { method: "PATCH", body: { ...eventBody(r), status: "confirmed" } });
			}
		}
		const next: ReminderStatus = { prefs: status.prefs, syncedAt: now, scheduled: wanted.size };
		writeStatus(next);
		return next;
	} catch (err) {
		const next = { ...status, error: err instanceof Error ? err.message : "Could not sync reminders." };
		writeStatus(next);
		return next;
	}
}

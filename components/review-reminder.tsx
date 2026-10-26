"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { localDay, reminderText, REVIEW_REMINDED_DAY_KEY, REVIEW_REMINDER_KEY, shouldRemind } from "@/src/core";

/**
 * THE DAILY REVIEW REMINDER (spaced repetition): opt-in per device (the
 * Review page's toggle). While the app is open, checks what is due on
 * mount and every half hour, and shows at most one system notification
 * a day when something is. Clicking it opens the Review page. Renders
 * nothing.
 */

const CHECK_EVERY_MS = 30 * 60 * 1000;

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function ReviewReminder() {
	const router = useRouter();
	useEffect(() => {
		let cancelled = false;
		const check = async () => {
			if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
			const enabled = read(REVIEW_REMINDER_KEY) === "on";
			const today = localDay(Date.now());
			if (!enabled || read(REVIEW_REMINDED_DAY_KEY) === today) return;
			let due = 0;
			try {
				const res = await fetch("/api/review");
				if (!res.ok) return;
				due = ((await res.json()) as { due: number }).due;
			} catch {
				return;
			}
			if (cancelled || !shouldRemind({ enabled, due, remindedDay: read(REVIEW_REMINDED_DAY_KEY), today })) return;
			try {
				localStorage.setItem(REVIEW_REMINDED_DAY_KEY, today);
			} catch {
				/* storage blocked: the reminder may repeat, never crash */
			}
			const { title, body } = reminderText(due);
			const n = new Notification(title, { body, tag: "lh-review" });
			n.onclick = () => {
				window.focus();
				router.push("/progress");
				n.close();
			};
		};
		void check();
		const timer = setInterval(() => void check(), CHECK_EVERY_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [router]);
	return null;
}

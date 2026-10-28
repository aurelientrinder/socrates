"use client";

import { useContext, useState } from "react";
import { ChatActionsContext } from "@/components/chat";
import { useAppearance } from "@/components/settings/appearance";

/** The invert disc (owner round, 2026-10-07): the half-filled circle that
 *  IS the invert toggle's sliding disc. Hand-rolled because lucide's
 *  Contrast leaves its half-moon unfilled (fill="none" by default) — the
 *  owner's catch: the filled side must be ACTUALLY filled. Same geometry
 *  as lucide's (circle r10 + left half-moon), the half carries
 *  fill="currentColor". */
export function InvertDiscIcon({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			aria-hidden
		>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 18a6 6 0 0 0 0-12v12z" fill="currentColor" stroke="none" />
		</svg>
	);
}

/** The invert switch's state, shared by the figure and demo cards. The
 *  learner's choice PERSISTS on the steer record (details.ui.inverted,
 *  owner 2026-10-07) through the silent artifact-ui route; without a chat
 *  page (tests, previews) it stays local. Until the learner picks, the
 *  switch follows the theme (dark mode pass, 2026-10-27): models draw for
 *  a white page, so in dark mode a figure or demo opens inverted instead
 *  of as a bright white block. */
export function useInvertSwitch(saved: boolean | undefined, messageId: string | undefined) {
	const actions = useContext(ChatActionsContext);
	const { effectiveMode } = useAppearance();
	const [choice, setChoice] = useState(saved);
	const inverted = choice ?? effectiveMode === "dark";
	const setInverted = (next: boolean) => {
		setChoice(next);
		if (!actions?.chatId || !messageId) return;
		void fetch(`/api/chats/${actions.chatId}/artifact-ui`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ input: { messageId, inverted: next } }),
		}).catch(() => {});
	};
	return [inverted, setInverted] as const;
}

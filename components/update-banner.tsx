"use client";

/**
 * The auto-update banner (Wave C, owner 2026-10-10: silent download +
 * restart-banner UX). The shell pushes "lh:update-status" once a staged
 * update exists (electron/main.cjs update-downloaded); this is the whole
 * renderer surface — a small fixed card, bottom-right, offering Restart.
 * Browser builds have no window.lh and never see a push: renders null.
 *
 * No dismiss: a downloaded update installs on quit anyway
 * (autoInstallOnAppQuit); the banner is a courtesy, not a gate.
 */

import { useEffect, useState } from "react";

// The window.lh bridge type lives in components/sidebar.tsx (the incumbent
// declare-global) — onUpdateStatus/installUpdate are declared there too.

type UpdateStatus = { status: string; version: string | null };

const SHOWN = new Set(["downloaded", "manual"]);

export default function UpdateBanner() {
	const [ready, setReady] = useState<UpdateStatus | null>(null);

	useEffect(() => {
		// Absent bridge (browser / dev) → stays hidden forever.
		const lh = window.lh;
		// The shell's push is one-shot and can fire before this page has loaded
		// (the window opens on a splash), so ask for the current state on mount.
		void lh?.getUpdateStatus?.().then(
			(s) => {
				if (s && SHOWN.has(s.status)) setReady(s);
			},
			() => {},
		);
		return lh?.onUpdateStatus?.((s) => {
			if (s && SHOWN.has(s.status)) setReady(s);
		});
	}, []);

	if (!ready) return null;
	// An update exists but this build cannot swap itself in place (macOS without
	// an Apple Developer ID): point at the download instead of a dead button.
	if (ready.status === "manual") {
		return (
			<div
				data-testid="update-banner"
				className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg"
			>
				<div className="text-sm">
					<span className="font-medium">Socrates {ready.version ?? "update"} is available</span>
					<span className="text-muted-foreground"> — download it to update.</span>
				</div>
				<button
					type="button"
					onClick={() => window.lh?.openUpdatePage?.()}
					className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
				>
					Download
				</button>
			</div>
		);
	}
	return (
		<div
			data-testid="update-banner"
			className="fixed right-4 bottom-4 z-50 flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg"
		>
			<div className="text-sm">
				<span className="font-medium">Socrates {ready.version ?? "update"} is ready</span>
				<span className="text-muted-foreground"> — restart to finish installing.</span>
			</div>
			<button
				type="button"
				onClick={() => window.lh?.installUpdate?.()}
				className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent/80"
			>
				Restart
			</button>
		</div>
	);
}

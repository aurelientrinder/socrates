"use client";

import { useState } from "react";

export interface SettingsRecoveredInfo {
	keptAs: string;
	restoredFrom: string | null;
}

/** Shown on Today after settings.json could not be read: says what was
 *  put back and where the damaged copy is, instead of a silent reset. */
export function SettingsRecoveredNote({ recovery }: { recovery: SettingsRecoveredInfo }) {
	const [open, setOpen] = useState(true);
	if (!open) return null;
	const dismiss = () => {
		setOpen(false);
		void fetch("/api/settings?notice", { method: "DELETE" }).catch(() => undefined);
	};
	return (
		<section data-testid="today-settings-recovered" role="status" className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-5 py-4">
			<h2 className="text-base font-semibold">Your settings were damaged</h2>
			<p className="text-base text-foreground/85">
				{recovery.restoredFrom
					? `Socrates could not read your settings file, so it put back the copy from ${recovery.restoredFrom}. Changes since then may be missing.`
					: "Socrates could not read your settings file and found no backup, so it is using the default settings. Check Settings for your model and theme."}{" "}
				The damaged file is kept as <code className="text-sm">{recovery.keptAs}</code> in your data folder.
			</p>
			<button type="button" onClick={dismiss} className="self-start text-sm font-medium underline-offset-2 hover:underline">
				Got it
			</button>
		</section>
	);
}

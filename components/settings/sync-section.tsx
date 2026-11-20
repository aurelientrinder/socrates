"use client";

import { useEffect, useState } from "react";
import type { SyncStats, SyncStatus } from "@/src/core";

/**
 * Encrypted Folder Sync controls inside Settings → Data & updates.
 * Configures a synced folder path (iCloud Drive, Dropbox, Syncthing, etc.)
 * and runs two-way AES-256-GCM encrypted merge on demand with the learner's
 * passphrase (never stored on disk).
 */
export function SyncControls() {
	const [status, setStatus] = useState<SyncStatus | null>(null);
	const [folder, setFolder] = useState("");
	const [passphrase, setPassphrase] = useState("");
	const [busy, setBusy] = useState<"save" | "sync" | null>(null);
	const [feedback, setFeedback] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

	useEffect(() => {
		let cancelled = false;
		fetch("/api/sync", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<SyncStatus>) : null))
			.then((data) => {
				if (cancelled || !data) return;
				setStatus(data);
				setFolder(data.folder ?? "");
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);

	async function saveFolder() {
		setBusy("save");
		setFeedback(null);
		try {
			const res = await fetch("/api/sync", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ folder: folder.trim() || null }),
			});
			const data = (await res.json()) as SyncStatus & { error?: string };
			if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
			setStatus(data);
			setFolder(data.folder ?? "");
			setFeedback({ tone: "ok", text: data.folder ? "Sync folder saved." : "Sync folder cleared." });
		} catch (err) {
			setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Could not save folder." });
		} finally {
			setBusy(null);
		}
	}

	async function runSync() {
		setBusy("sync");
		setFeedback(null);
		try {
			const res = await fetch("/api/sync", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ passphrase, folder: folder.trim() || undefined }),
			});
			const data = (await res.json()) as { status?: SyncStatus; stats?: SyncStats; error?: string };
			if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
			if (data.status) setStatus(data.status);
			const s = data.stats;
			const summary = s
				? `Synced (${s.added} added, ${s.updated} updated, ${s.mergedDecks} decks & ${s.mergedLedgers} ledgers merged).`
				: "Synced.";
			setFeedback({ tone: "ok", text: summary });
		} catch (err) {
			setFeedback({ tone: "error", text: err instanceof Error ? err.message : "Sync failed." });
		} finally {
			setBusy(null);
		}
	}

	return (
		<div data-testid="sync-controls" className="flex flex-col gap-3 px-4 py-3">
			<div className="flex flex-wrap items-center gap-2">
				<input
					type="text"
					value={folder}
					onChange={(e) => setFolder(e.target.value)}
					placeholder="~/Library/Mobile Documents/com~apple~CloudDocs/Socrates"
					aria-label="Sync folder path"
					disabled={busy !== null}
					className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 text-[13px] placeholder:text-muted-foreground/60"
				/>
				<button
					type="button"
					onClick={() => void saveFolder()}
					disabled={busy !== null}
					className="h-8 shrink-0 rounded-lg border border-border bg-surface px-3 text-[13px] hover:bg-accent disabled:opacity-60"
				>
					{busy === "save" ? "Saving…" : "Save folder"}
				</button>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<input
					type="password"
					value={passphrase}
					onChange={(e) => setPassphrase(e.target.value)}
					placeholder="Sync passphrase (min 6 chars)"
					aria-label="Sync passphrase"
					disabled={busy !== null}
					className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 text-[13px] placeholder:text-muted-foreground/60"
				/>
				<button
					type="button"
					onClick={() => void runSync()}
					disabled={busy !== null || !folder.trim() || passphrase.length < 6}
					className="h-8 shrink-0 rounded-lg border border-border bg-card px-3 text-[13px] font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
				>
					{busy === "sync" ? "Syncing…" : "Sync now"}
				</button>
			</div>
			{status?.lastSyncedAt && (
				<p className="text-xs text-muted-foreground tabular-nums">
					Last synced {new Date(status.lastSyncedAt).toLocaleString()} · device {status.deviceId}
				</p>
			)}
			{feedback && (
				<p
					role={feedback.tone === "error" ? "alert" : "status"}
					className={feedback.tone === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
				>
					{feedback.text}
				</p>
			)}
		</div>
	);
}

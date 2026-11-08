"use client";
/**
 * "Models in menus" (Settings → Providers, 2026-11-04): a provider can
 * offer 40+ models, so the learner picks which ones the model menus list.
 * One folded row per keyed provider ("5 of 40 shown"); unfolded, a search
 * field and a checklist. No list stored = every model shows. The write is
 * the `modelList` section (replace-whole, PUT /api/settings/modelList);
 * the model menus narrow the same full catalog (visibleModels), so a model
 * already in use stays selectable even when unchecked here.
 */

import { useCallback, useEffect, useState } from "react";
import type { ModelCatalogEntry, ModelCatalogResponse } from "@/src/core";
import { fuzzyScore } from "@/src/core";
import { notifySettingsSaved, useSettingsSaved } from "@/components/settings-signal";
import { SettingsGroup } from "./controls.tsx";

/** Toggle one model in a provider's list. Pure — exported for tests.
 *  `current` undefined = everything shown. Returns the provider's next
 *  list, or null when it ends up showing everything (the key drops).
 *  The last shown model can't be unchecked (an empty menu helps no one). */
export function toggleShown(
	allIds: string[],
	current: string[] | undefined,
	id: string,
): string[] | null | undefined {
	const set = new Set(current ?? allIds);
	if (set.has(id)) {
		if (set.size === 1) return undefined; // refuse: keep at least one
		set.delete(id);
	} else set.add(id);
	const next = allIds.filter((x) => set.has(x));
	return next.length === allIds.length ? null : next;
}

export function ModelVisibility() {
	const [catalog, setCatalog] = useState<ModelCatalogResponse | null>(null);
	const [shown, setShown] = useState<Record<string, string[]>>({});
	const [open, setOpen] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);

	const read = useCallback(() => {
		fetch("/api/models")
			.then((r) => (r.ok ? (r.json() as Promise<ModelCatalogResponse>) : Promise.reject()))
			.then((c) => { setCatalog(c); setShown(c.shown ?? {}); })
			.catch(() => setCatalog(null));
	}, []);
	useEffect(read, [read]);
	useSettingsSaved((section) => { if (section === "keys") read(); });

	const save = async (next: Record<string, string[]>) => {
		setError(null);
		const prev = shown;
		setShown(next);
		try {
			const res = await fetch("/api/settings/modelList", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(Object.keys(next).length ? { shown: next } : {}),
			});
			if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? String(res.status));
			notifySettingsSaved("modelList");
		} catch (e) {
			setShown(prev);
			setError(e instanceof Error ? e.message : "Could not save.");
		}
	};

	const byProvider = new Map<string, ModelCatalogEntry[]>();
	for (const m of catalog?.models ?? []) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
	const providers = [...byProvider.entries()].filter(([, models]) => models.length > 1);
	if (!catalog || providers.length === 0) return null;

	return (
		<SettingsGroup label="Models in menus" hint="Choose which models the model menus list. A model you already use always stays available." testid="group-model-list">
			{providers.map(([provider, models]) => {
				const ids = models.map((m) => m.id);
				const current = shown[provider]?.filter((id) => ids.includes(id));
				const count = current?.length ? current.length : ids.length;
				const isOpen = open === provider;
				const rows = isOpen
					? models
							.map((m) => ({ m, s: fuzzyScore(query, m.id, m.name) }))
							.filter((r) => r.s !== null)
							.sort((a, b) => b.s! - a.s! || a.m.id.localeCompare(b.m.id))
							.map((r) => r.m)
					: [];
				return (
					<div key={provider} data-testid={`model-list-${provider}`}>
						<button
							type="button"
							aria-expanded={isOpen}
							onClick={() => { setOpen(isOpen ? null : provider); setQuery(""); }}
							className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent/40"
						>
							<span className="text-[14.5px] font-medium">{provider}</span>
							<span className="text-[13px] text-muted-foreground">
								{count === ids.length ? `All ${ids.length} shown` : `${count} of ${ids.length} shown`}
							</span>
						</button>
						{isOpen && (
							<div className="flex flex-col gap-1.5 border-t border-border/60 px-4 py-2">
								<div className="flex items-center gap-2">
									<input
										value={query}
										onChange={(e) => setQuery(e.target.value)}
										placeholder="Search models…"
										className="lh-input min-w-0 flex-1 rounded-lg border bg-background px-2 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
									/>
									<button
										type="button"
										disabled={!current}
										onClick={() => { const { [provider]: _drop, ...rest } = shown; void save(rest); }}
										className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-40"
									>
										Show all
									</button>
								</div>
								<ul className="flex max-h-60 flex-col overflow-y-auto">
									{rows.map((m) => {
										const checked = current ? current.includes(m.id) : true;
										return (
											<li key={m.id}>
												<label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 text-xs hover:bg-muted">
													<input
														type="checkbox"
														checked={checked}
														data-testid={`model-shown-${m.id.replace(/[^a-z0-9-]/gi, "_")}`}
														onChange={() => {
															const next = toggleShown(ids, current, m.id);
															if (next === undefined) return;
															const { [provider]: _drop, ...rest } = shown;
															void save(next === null ? rest : { ...rest, [provider]: next });
														}}
														className="mt-0.5 accent-foreground"
													/>
													<span className="min-w-0 break-words text-card-foreground">
														{m.name}
														<span className="ml-1.5 break-all text-muted-foreground">{m.id !== m.name ? m.id : ""}</span>
													</span>
												</label>
											</li>
										);
									})}
									{rows.length === 0 && <li className="px-1 py-2 text-xs text-muted-foreground">No models match.</li>}
								</ul>
							</div>
						)}
					</div>
				);
			})}
			{error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{error}</p>}
		</SettingsGroup>
	);
}

"use client";
/**
 * Thin settings primitives (settings-app wave): the control kit the
 * settings dialog needs. Sections → groups → rows; everything SSRs clean
 * (render tests pin the sections' markup).
 *
 * The dependency graying (owner, 2026-09-20) follows the graph viewer's
 * render-panel convention: the WHOLE row dims (opacity-40, label and
 * control together) and the control itself locks — the row owns the dim.
 */

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A section page (settings redesign, 2026-11-08): a large title, one
 *  plain line under it, then the groups. */
export function SettingsSection({
	title,
	hint,
	children,
	testid,
}: {
	title: string;
	/** One plain line under the title: what this page is about. */
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<section data-testid={testid} className="px-8 pt-7 pb-8">
			<h2 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
			{hint && <p className="mt-0.5 text-[14px] text-muted-foreground">{hint}</p>}
			<div className="mt-6 flex flex-col gap-6">{children}</div>
		</section>
	);
}

/** A titled card of rows: heading, optional plain line, then the rows
 *  divided by hairlines. */
export function SettingsGroup({
	label,
	hint,
	children,
	testid,
	bare,
}: {
	label?: string;
	hint?: string;
	children: React.ReactNode;
	testid?: string;
	/** No card around the children (free-form content like prompt editors). */
	bare?: boolean;
}) {
	return (
		<div data-testid={testid} className="flex flex-col gap-2">
			{(label || hint) && (
				<div>
					{label && <h3 className="text-[13px] font-semibold text-muted-foreground">{label}</h3>}
					{hint && <p className="text-[12.5px] text-muted-foreground">{hint}</p>}
				</div>
			)}
			<div className={bare ? "flex flex-col gap-2" : "divide-y divide-border/60 rounded-xl border border-border/70 bg-surface"}>{children}</div>
		</div>
	);
}

/** Folded-away rows for people who want to tinker. */
export function SettingsAdvanced({ children, testid }: { children: React.ReactNode; testid?: string }) {
	return (
		<details data-testid={testid} className="group/adv flex flex-col gap-4">
			<summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-[13px] font-semibold text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
				<svg viewBox="0 0 16 16" className="size-3.5 transition-transform group-open/adv:rotate-90" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
					<path d="M6 4l4 4-4 4" />
				</svg>
				Advanced
			</summary>
			<div className="mt-3 flex flex-col gap-6">{children}</div>
		</details>
	);
}

/** One label + one control. Label left (with an optional plain line),
 *  control right. Lives inside a SettingsGroup card. */
export function SettingsRow({
	label,
	hint,
	children,
	testid,
	dimmed,
}: {
	label: string;
	hint?: string;
	children: React.ReactNode;
	testid?: string;
	/** Dependency graying: the whole row dims when the control is inert. */
	dimmed?: boolean;
}) {
	return (
		<div data-testid={testid} className={cn("flex items-center justify-between gap-4 px-4 py-3", dimmed && "opacity-40")}>
			<span className="min-w-0">
				<span className="block text-[14.5px] font-medium text-foreground">{label}</span>
				{hint && <span className="block text-[13px] text-muted-foreground">{hint}</span>}
			</span>
			{children}
		</div>
	);
}

/** A segmented choice: exactly one option is on. */
export function Segmented<T extends string>({
	options,
	value,
	onChange,
	ariaLabel,
	testid,
}: {
	options: readonly { value: T; label: string }[];
	value: T | null;
	onChange: (next: T) => void;
	ariaLabel: string;
	testid?: string;
}) {
	return (
		<div role="radiogroup" aria-label={ariaLabel} data-testid={testid} className="flex shrink-0 rounded-lg bg-accent/60 p-0.5 text-[13px]">
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					role="radio"
					aria-checked={o.value === value}
					data-testid={testid ? `${testid}-${o.value}` : undefined}
					onClick={() => onChange(o.value)}
					className={cn(
						"rounded-md px-2.5 py-1 transition-colors",
						o.value === value ? "bg-surface font-semibold text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
					)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

/** The on/off switch — a plain button in the switch role. */
export function Toggle({
	checked,
	disabled,
	onChange,
	label,
	discIcon,
	title,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
	/** Accessible name for the switch role. */
	label: string;
	/** Optional icon disc (owner round, 2026-10-07): the figure cards' invert
	 *  toggle renders the half-filled contrast circle AS the disc — the icon
	 *  carries the meaning; plain toggles keep the plain disc. */
	discIcon?: ReactNode;
	/** Optional native tooltip on the switch. */
	title?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			{...(title ? { title } : {})}
			disabled={disabled}
			data-testid={`toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative h-5 w-9 shrink-0 rounded-full transition-colors",
				// Ink switch (settings redesign): on = an ink track, off = a quiet
				// outlined track.
				checked ? "bg-foreground" : "bg-accent ring-1 ring-border ring-inset",
				disabled && "cursor-not-allowed",
			)}
		>
			{discIcon ? (
				// The icon IS the disc: same size, same slide, same state colors —
				// only the knob's face changes (the invert affordance).
				<span
					className={cn(
						"absolute left-0 top-0.5 flex size-4 items-center justify-center rounded-full bg-background shadow-xs transition-transform",
						checked ? "translate-x-4.5 text-foreground" : "translate-x-0.5 text-muted-foreground",
					)}
				>
					{discIcon}
				</span>
			) : (
				<span
					className={cn(
						"absolute left-0 top-0.5 size-4 rounded-full bg-background shadow-xs transition-transform",
						checked ? "translate-x-4.5" : "translate-x-0.5",
					)}
				/>
			)}
		</button>
	);
}

/** A thin select — native element, options as given. */
export function ThinSelect({
	value,
	onChange,
	children,
	ariaLabel,
	testid,
	disabled,
}: {
	value: string;
	onChange: (next: string) => void;
	children: React.ReactNode;
	ariaLabel: string;
	testid?: string;
	disabled?: boolean;
}) {
	return (
		<select
			value={value}
			aria-label={ariaLabel}
			data-testid={testid}
			disabled={disabled}
			onChange={(e) => onChange(e.target.value)}
			className={cn(
				"h-8 rounded-lg border border-border bg-surface px-2 font-ui text-[13px] text-foreground outline-none",
				disabled && "cursor-not-allowed",
			)}
		>
			{children}
		</select>
	);
}

/** A thin hex/text input committing on blur + Enter (settings pace, not
 *  typing pace — every commit is a section PUT). */
export function CommitInput({
	value,
	placeholder,
	onCommit,
	ariaLabel,
	testid,
	type = "text",
}: {
	/** "" = unset (the factory default). Mirrors the STORED record —
	 *  after a clamped/normalized commit this flows back and the field
	 *  snaps to the stored truth (owner repro: a negative size kept
	 *  displaying "-5" while 12 was stored). */
	value: string;
	placeholder?: string;
	onCommit: (next: string) => void;
	ariaLabel: string;
	testid?: string;
	type?: "text" | "number";
}) {
	// The draft exists only while editing; a blur shows the record's value
	// again — commit-on-blur/Enter (owner ruling), the field honest about
	// what landed.
	const [draft, setDraft] = useState(value);
	const [editing, setEditing] = useState(false);
	return (
		<input
			type={type}
			value={editing ? draft : value}
			placeholder={placeholder}
			aria-label={ariaLabel}
			data-testid={testid}
			onChange={(e) => {
				setEditing(true);
				setDraft(e.target.value);
			}}
			onBlur={() => {
				if (!editing) return;
				setEditing(false);
				const next = draft.trim();
				if (next !== value) onCommit(next);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					setEditing(false);
					e.currentTarget.blur();
				}
			}}
			className="h-8 w-40 rounded-lg border border-border bg-surface px-2.5 font-ui text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-foreground/40"
		/>
	);
}
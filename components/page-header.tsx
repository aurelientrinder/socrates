import Link from "next/link";
import { SidebarToggle } from "@/components/sidebar";
import { cn } from "@/lib/utils";

/**
 * THE PAGE FRAME (redesign wave, 2026-10-26): every top-level page (Today,
 * Progress, Library) opens with the same header — the sidebar toggle when
 * the sidebar is closed, a serif title, optional actions on the right —
 * over one centered column. Replaces the tiny all-caps eyebrow each page
 * used to carry as its only title.
 */
export function PageFrame({
	title,
	actions,
	testId,
	width = "max-w-4xl",
	children,
}: {
	title: string;
	actions?: React.ReactNode;
	testId?: string;
	/** The column's max width (a Tailwind max-w-* class). */
	width?: string;
	children: React.ReactNode;
}) {
	return (
		<div data-testid={testId} className="h-full overflow-y-auto">
			<div className={cn("mx-auto flex flex-col gap-8 px-6 pb-14 pt-8 sm:px-10", width)}>
				<PageHead title={title} actions={actions} />
				{children}
			</div>
		</div>
	);
}

/** The page's title row: the sidebar toggle when the sidebar is closed,
 *  the serif title, actions on the right. A window-drag band in the
 *  desktop app (its buttons and links carve themselves out). */
export function PageHead({ title, actions }: { title: string; actions?: React.ReactNode }) {
	return (
		<header className="lh-drag flex flex-wrap items-center gap-3">
			<SidebarToggle />
			<h1 className="lh-page-title min-w-0 flex-1 text-[34px] leading-tight">{title}</h1>
			{actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
		</header>
	);
}

/** A section heading inside a page: sentence case, readable size. */
export function SectionHeading({ children, className }: { children: React.ReactNode; className?: string }) {
	return <h2 className={cn("text-lg font-semibold text-foreground", className)}>{children}</h2>;
}

/** The Progress page's views. Memory, Weak spots and Calibration render
 *  inside /progress; Map is the knowledge map at /map, under the same header. */
export const PROGRESS_TABS = [
	{ id: "memory", label: "Memory", href: "/progress" },
	{ id: "weak-spots", label: "Weak spots", href: "/progress?tab=weak-spots" },
	{ id: "calibration", label: "Calibration", href: "/progress?tab=calibration" },
	{ id: "cards", label: "Flashcards", href: "/progress?tab=cards" },
	{ id: "map", label: "Map", href: "/map" },
];

/** The Library's views: everything you studied from, and the class calendar. */
export const LIBRARY_TABS = [
	{ id: "overview", label: "Overview", href: "/library" },
	{ id: "calendar", label: "Calendar", href: "/library?tab=calendar" },
];

/** Underlined tabs as links (?tab=…), so each tab is a real address. */
export function PageTabs({ tabs, active }: { tabs: { id: string; label: string; href: string }[]; active: string }) {
	return (
		<nav aria-label="Views" className="-mt-2 flex gap-1 overflow-x-auto border-b">
			{tabs.map((t) => (
				<Link
					key={t.id}
					href={t.href}
					data-testid={`tab-${t.id}`}
					aria-current={t.id === active ? "page" : undefined}
					className={cn(
						"-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-base transition-colors",
						t.id === active
							? "border-foreground font-semibold text-foreground"
							: "border-transparent text-muted-foreground hover:text-foreground",
					)}
				>
					{t.label}
				</Link>
			))}
		</nav>
	);
}

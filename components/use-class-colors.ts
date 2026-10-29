"use client";

import { useEffect, useMemo, useState } from "react";
import type { LensClass } from "@/src/core";

let pending: Promise<LensClass[]> | null = null;

/** The classes and their colors, fetched once and shared by every caller on the page. */
function loadClasses(): Promise<LensClass[]> {
	pending ??= fetch("/api/courses/lens")
		.then((r) => (r.ok ? (r.json() as Promise<{ classes: LensClass[] }>) : { classes: [] }))
		.then((d) => d.classes)
		.catch(() => []);
	return pending;
}

/** The classes that own sessions, fetched once per page. */
export function useClasses(): LensClass[] {
	const [classes, setClasses] = useState<LensClass[]>([]);
	useEffect(() => {
		let live = true;
		void loadClasses().then((list) => live && setClasses(list));
		return () => {
			live = false;
		};
	}, []);
	return classes;
}

/** class key → color index (the calendar's `.cal-c0..5`), empty until loaded. */
export function useClassColors(): Map<string, number> {
	const classes = useClasses();
	return useMemo(() => new Map(classes.map((c) => [c.key, c.color])), [classes]);
}

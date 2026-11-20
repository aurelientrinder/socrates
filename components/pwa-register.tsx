"use client";

import { useEffect } from "react";

/** Registers the lightweight PWA service worker in regular browsers (no-op in Electron). */
export function PwaRegister() {
	useEffect(() => {
		if (typeof window === "undefined") return;
		if ("lh" in window) return; // Electron desktop shell does not need a SW.
		if (!("serviceWorker" in navigator)) return;
		navigator.serviceWorker.register("/sw.js").catch(() => undefined);
	}, []);
	return null;
}

const CACHE = "socrates-pwa-v1";
const PRECACHE = ["/mobile", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.catch(() => undefined)
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

// Network-first for GET navigations/assets; never intercept API mutations or SSE streams.
self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith("/api/")) return;

	event.respondWith(
		fetch(req)
			.then((res) => {
				if (res.ok && res.type === "basic") {
					const copy = res.clone();
					caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => undefined);
				}
				return res;
			})
			.catch(() => caches.match(req).then((hit) => hit || caches.match("/mobile"))),
	);
});

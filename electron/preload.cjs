/*
 * Preload (2026-09-17, narrow-window wave): the ONLY bridge between the
 * sandboxed renderer and the main process. contextIsolation + sandbox are
 * on (electron/main.cjs), so this file is the renderer's entire access to
 * Electron — keep it a minimal, explicit API surface.
 *
 *   window.lh.platform — read-only OS identity for native window-control
 *   gutters (darwin: left traffic lights; win32/linux: right overlay).
 *
 *   window.lh.expandWindow() — widen the window to the sidebar auto-close
 *   threshold (928px) when the sidebar is opened below it. The main
 *   process clamps: no-op if the window is already wide enough.
 *
 *   window.lh.onZoom(cb) / window.lh.getZoom() — the zoom truth (owner
 *   round 7, 2026-10-05): every ⌘±/⌘0 change arrives as "lh:zoom" with
 *   the new factor; getZoom covers the first-paint race. The renderer
 *   publishes it as --lh-zoom so physical-constant lengths (the traffic-
 *   light gutter) can divide by it.
 *
 *   window.lh.onUpdateStatus(cb) / window.lh.installUpdate() — the
 *   auto-update channel (Wave C, 2026-10-10): "lh:update-status" pushes
 *   {status:"downloaded", version} once an update is staged; installUpdate
 *   asks main to kill the server and quit-and-install. Browser builds:
 *   both absent, the banner never renders.
 *
 *   window.lh.pickFolder() / window.lh.openWatchedFolder(sub?) — the
 *   watched notes folder (2026-11-01): the system folder picker, and the
 *   watched folder (or a class folder in it) shown in Explorer/Finder.
 *
 *   window.lh.openNote(id) — open a saved note's original file (the notes
 *   library, data/notes/<id>/) in the system's default app. Main resolves
 *   the path itself from the id; the renderer never names a path.
 *
 *   window.lh.listCaptureWindows() / window.lh.captureWindow(id, full) —
 *   live reMarkable capture (2026-11-08): the open windows (id, name,
 *   thumbnail), and one picture of a window by id (small JPEG preview, or
 *   a full PNG snapshot when `full`). Pictures only; nothing is stored.
 *
 * Channel names are mirrored in electron/main.cjs — keep them in sync.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lh", {
	platform: process.platform,
	expandWindow: () => ipcRenderer.send("lh:expand-window"),
	onZoom: (cb) => {
		const listener = (_event, factor) => cb(factor);
		ipcRenderer.on("lh:zoom", listener);
		return () => ipcRenderer.removeListener("lh:zoom", listener);
	},
	getZoom: () => ipcRenderer.invoke("lh:zoom:get"),
	onUpdateStatus: (cb) => {
		const listener = (_event, status) => cb(status);
		ipcRenderer.on("lh:update-status", listener);
		return () => ipcRenderer.removeListener("lh:update-status", listener);
	},
	installUpdate: () => ipcRenderer.send("lh:update-install"),
	// Replays the newest update state to a page that mounted after the push.
	getUpdateStatus: () => ipcRenderer.invoke("lh:update-state"),
	openUpdatePage: () => ipcRenderer.send("lh:update-open"),
	// Theme sync: the last persisted theme (read once, synchronously, so the
	// page's pre-paint script can use it) and the live report back.
	bootTheme: (() => {
		try {
			return ipcRenderer.sendSync("lh:theme:boot");
		} catch {
			return null;
		}
	})(),
	setTheme: (theme) => ipcRenderer.send("lh:theme", theme),
	openNote: (id) => ipcRenderer.invoke("lh:notes:open", id),
	// Watched notes folder: the system folder picker (null when cancelled),
	// and show the watched folder (or one class folder of it) in Explorer/Finder.
	pickFolder: () => ipcRenderer.invoke("lh:folder:pick"),
	openWatchedFolder: (sub) => ipcRenderer.invoke("lh:folder:open", sub),
	listCaptureWindows: () => ipcRenderer.invoke("lh:capture:list"),
	captureWindow: (id, full) => ipcRenderer.invoke("lh:capture:grab", id, full === true),
});

const { contextBridge, ipcRenderer, webUtils } = require("electron");

// The only surface the web app sees. Keep it small and explicit.
// Typed on the web side in apps/web/src/desktop/bridge.ts.
contextBridge.exposeInMainWorld("desktop", {
	isDesktop: true,
	isE2E: process.argv.includes("--shell-e2e"),
	/** Real on-disk path of a File picked or dropped by the user ("" if it has none). */
	getPathForFile: (file) => webUtils.getPathForFile(file),
	fileExists: (filePath) => ipcRenderer.invoke("desktop:file-exists", filePath),
	saveDialog: (options) => ipcRenderer.invoke("desktop:save-dialog", options),
	openDialog: (options) => ipcRenderer.invoke("desktop:open-dialog", options),
	writeTextFile: (request) => ipcRenderer.invoke("desktop:write-text-file", request),
	readTextFile: (filePath) => ipcRenderer.invoke("desktop:read-text-file", filePath),
	readMediaFile: (filePath) => ipcRenderer.invoke("desktop:read-media-file", filePath),
	showItemInFolder: (filePath) => ipcRenderer.invoke("desktop:show-item", filePath),
	cacheMedia: (request) => ipcRenderer.invoke("desktop:cache-media", request),
	mlt: {
		status: () => ipcRenderer.invoke("mlt:status"),
		audioChannels: (filePath) => ipcRenderer.invoke("mlt:audio-channels", filePath),
		chooseBinDir: () => ipcRenderer.invoke("mlt:choose-bin-dir"),
		render: (request) => ipcRenderer.invoke("mlt:render", request),
		previewFrame: (request) => ipcRenderer.invoke("mlt:preview-frame", request),
		previewClip: (request) => ipcRenderer.invoke("mlt:preview-clip", request),
		cancel: (jobId) => ipcRenderer.invoke("mlt:cancel", jobId),
		/** Subscribes to render progress; returns an unsubscribe function. */
		onProgress: (listener) => {
			const handler = (_event, payload) => listener(payload);
			ipcRenderer.on("mlt:progress", handler);
			return () => ipcRenderer.removeListener("mlt:progress", handler);
		},
	},
});

const { app, dialog, ipcMain, shell, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const mlt = require("./mlt.cjs");

// e2e scripts queue answers here so native dialogs never block a test run.
const dialogAnswers = [];
const queueDialogAnswer = (answer) => dialogAnswers.push(answer);

const MAX_PROJECT_FILE_BYTES = 64 * 1024 * 1024;
const MEDIA_EXTENSIONS = new Set([
	".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpg", ".mpeg", ".ts", ".mts", ".wmv", ".flv",
	".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma",
	".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".avif", ".tif", ".tiff",
]);
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_EXTENSION = /^\.[A-Za-z0-9]{1,8}$/;

const DERIVED_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Pictures drawn for text, shapes and masks are cheap to redraw and pile up as the user
 * edits, so old ones are removed at startup. Copies of the user's own media stay: a saved
 * project file may be the only thing that still points at them.
 */
async function pruneDerivedCache() {
	const dir = path.join(app.getPath("userData"), "media-cache");
	const names = await fs.readdir(dir).catch(() => []);
	const cutoff = Date.now() - DERIVED_CACHE_MAX_AGE_MS;
	for (const name of names) {
		if (!/^(raster|matte)-[0-9a-f]+\.png$/.test(name)) continue;
		const file = path.join(dir, name);
		const stats = await fs.stat(file).catch(() => null);
		if (stats && stats.mtimeMs < cutoff) await fs.rm(file, { force: true }).catch(() => {});
	}
}

function registerIpc() {
	void pruneDerivedCache();

	ipcMain.handle("desktop:file-exists", async (_event, filePath) => {
		if (typeof filePath !== "string" || !filePath) return false;
		try {
			return (await fs.stat(filePath)).isFile();
		} catch {
			return false;
		}
	});

	ipcMain.handle("desktop:save-dialog", async (event, options) => {
		if (dialogAnswers.length) return dialogAnswers.shift();
		const win = BrowserWindow.fromWebContents(event.sender);
		const extension = String(options?.extension ?? "").replace(/^\./, "");
		const { canceled, filePath } = await dialog.showSaveDialog(win, {
			defaultPath: path.join(app.getPath("videos"), String(options?.defaultName ?? "export")),
			filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : [],
		});
		return canceled ? null : filePath;
	});

	ipcMain.handle("desktop:open-dialog", async (event, options) => {
		if (dialogAnswers.length) return dialogAnswers.shift();
		const win = BrowserWindow.fromWebContents(event.sender);
		const extension = String(options?.extension ?? "").replace(/^\./, "");
		const { canceled, filePaths } = await dialog.showOpenDialog(win, {
			properties: ["openFile"],
			filters: extension ? [{ name: String(options?.name ?? extension), extensions: [extension] }] : [],
		});
		return canceled ? null : (filePaths[0] ?? null);
	});

	// Reading and writing are limited to what a project file needs: one text file the user
	// chose in a dialog, and media files that such a project refers to.
	ipcMain.handle("desktop:write-text-file", async (_event, { filePath, text }) => {
		if (typeof filePath !== "string" || !path.isAbsolute(filePath) || typeof text !== "string") {
			throw new Error("Invalid write request");
		}
		await fs.writeFile(filePath, text, "utf8");
	});

	ipcMain.handle("desktop:read-text-file", async (_event, filePath) => {
		if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("Invalid read request");
		const stats = await fs.stat(filePath);
		if (stats.size > MAX_PROJECT_FILE_BYTES) throw new Error("That file is too large to be a project file.");
		return fs.readFile(filePath, "utf8");
	});

	ipcMain.handle("desktop:read-media-file", async (_event, filePath) => {
		if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("Invalid read request");
		if (!MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
			throw new Error("Not a media file");
		}
		return fs.readFile(filePath);
	});

	ipcMain.handle("desktop:show-item", async (_event, filePath) => {
		if (typeof filePath === "string" && path.isAbsolute(filePath)) shell.showItemInFolder(filePath);
	});

	// Media that has no on-disk original (pasted, or imported before the shell existed)
	// is written here once so melt has a file to read.
	ipcMain.handle("desktop:cache-media", async (_event, { id, extension, data }) => {
		if (!SAFE_ID.test(String(id)) || !SAFE_EXTENSION.test(String(extension))) {
			throw new Error("Invalid media cache request");
		}
		const dir = path.join(app.getPath("userData"), "media-cache");
		await fs.mkdir(dir, { recursive: true });
		const target = path.join(dir, `${id}${extension}`);
		await fs.writeFile(target, Buffer.from(data));
		return target;
	});

	ipcMain.handle("mlt:status", () => mlt.getStatus());

	ipcMain.handle("mlt:choose-bin-dir", async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		const answer = dialogAnswers.length
			? { canceled: false, filePaths: [dialogAnswers.shift()] }
			: await dialog.showOpenDialog(win, {
					title: "Select the folder that contains melt",
					properties: ["openDirectory"],
				});
		if (answer.canceled || !answer.filePaths[0]) return mlt.getStatus();
		if (!mlt.setMltBinDir(answer.filePaths[0])) {
			return { ...(await mlt.getStatus()), error: "That folder does not contain melt." };
		}
		return mlt.getStatus();
	});

	ipcMain.handle("mlt:render", async (event, { jobId, xml, outputPath, properties }) => {
		if (!SAFE_ID.test(String(jobId))) return { ok: false, error: "Invalid job id." };
		return mlt.render({
			jobId,
			xml,
			outputPath,
			properties,
			onProgress: (progress) => {
				if (!event.sender.isDestroyed()) event.sender.send("mlt:progress", { jobId, progress });
			},
		});
	});

	// Buffers cross IPC as Uint8Array; the page turns them into Blob URLs.
	ipcMain.handle("mlt:preview-frame", (_event, { xml, frame }) => mlt.renderFrame({ xml, frame }));

	ipcMain.handle("mlt:preview-clip", async (event, { jobId, xml }) => {
		if (!SAFE_ID.test(String(jobId))) return { ok: false, error: "Invalid job id." };
		return mlt.renderPreviewClip({
			jobId,
			xml,
			onProgress: (progress) => {
				if (!event.sender.isDestroyed()) event.sender.send("mlt:progress", { jobId, progress });
			},
		});
	});

	ipcMain.handle("mlt:cancel", (_event, jobId) => mlt.cancel(jobId));

	app.on("before-quit", () => mlt.cancelAll());
}

module.exports = { registerIpc, queueDialogAnswer };

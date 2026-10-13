const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const { startWebServer } = require("./web-server.cjs");
const { registerIpc } = require("./ipc.cjs");
const { runE2E } = require("./e2e-runner.cjs");

const production = process.argv.includes("--prod");
const e2eArg = process.argv.find((arg) => arg.startsWith("--e2e="));
const e2eScript = e2eArg ? path.resolve(e2eArg.slice("--e2e=".length)) : null;

// Keep e2e runs away from the user's real projects.
if (e2eScript) {
	app.setPath("userData", path.join(app.getPath("temp"), "meltcut-shell-e2e"));
}

let webServer = null;

async function createWindow() {
	webServer = await startWebServer({ production });
	const { origin } = webServer;

	const win = new BrowserWindow({
		width: 1440,
		height: 900,
		show: !e2eScript,
		backgroundColor: "#111111",
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
			// Imports, previews and the built-in exporter run in the page; they must not slow
			// to a crawl when the window is minimised or covered.
			backgroundThrottling: false,
			additionalArguments: e2eScript ? ["--shell-e2e"] : [],
		},
	});

	// The window only ever shows the local app; everything else opens in the system browser.
	const isLocal = (url) => url.startsWith(`${origin}/`) || url === origin;
	win.webContents.on("will-navigate", (event, url) => {
		if (!isLocal(url)) {
			event.preventDefault();
			if (/^https?:/.test(url)) shell.openExternal(url);
		}
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url) && !isLocal(url)) shell.openExternal(url);
		return { action: "deny" };
	});

	await win.loadURL(`${origin}/projects`);
	return { win, origin };
}

// One window per user: a second launch would fight over the server port and the storage.
if (!app.requestSingleInstanceLock()) {
	app.quit();
}
app.on("second-instance", () => {
	const [win] = BrowserWindow.getAllWindows();
	if (!win) return;
	if (win.isMinimized()) win.restore();
	win.focus();
});

app.whenReady().then(async () => {
	registerIpc();
	try {
		const { win, origin } = await createWindow();
		if (e2eScript) {
			const exitCode = await runE2E({ win, origin, scriptPath: e2eScript });
			webServer?.stop();
			app.exit(exitCode);
		}
	} catch (error) {
		console.error(error);
		webServer?.stop();
		app.exit(1);
	}
});

app.on("window-all-closed", () => {
	webServer?.stop();
	app.quit();
});

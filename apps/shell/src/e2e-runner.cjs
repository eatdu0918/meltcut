// Drives the real window from a script: `electron . --e2e=path/to/script.cjs`.
// A script exports `async (ctx) => {}` and throws to fail.
const fs = require("node:fs/promises");
const path = require("node:path");
const { queueDialogAnswer } = require("./ipc.cjs");

async function runE2E({ win, origin, scriptPath }) {
	const wc = win.webContents;
	const consoleErrors = [];
	wc.on("console-message", (details) => {
		if (details.level === "error") consoleErrors.push(details.message);
	});

	const exec = (code) => wc.executeJavaScript(`(async () => { ${code} })()`, true);
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	const ctx = {
		win,
		origin,
		exec,
		sleep,
		consoleErrors,
		/** Pre-answers the next native file dialog with this path. */
		queueDialogAnswer,
		async waitFor(code, { timeout = 30_000, label = code } = {}) {
			const deadline = Date.now() + timeout;
			for (;;) {
				const value = await exec(`return (${code})`).catch(() => null);
				if (value) return value;
				if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
				await sleep(200);
			}
		},
		async goto(pathname) {
			await win.loadURL(`${origin}${pathname}`);
		},
		/** Sets real files on an <input type="file">, as if the user picked them in the OS dialog. */
		async setInputFiles(selector, files) {
			if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
			const { root } = await wc.debugger.sendCommand("DOM.getDocument");
			const { nodeId } = await wc.debugger.sendCommand("DOM.querySelector", {
				nodeId: root.nodeId,
				selector,
			});
			if (!nodeId) throw new Error(`No element matches ${selector}`);
			await wc.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files });
		},
		async screenshot(filePath) {
			// A hidden window keeps showing its last painted frame, so surface it (without
			// taking focus) just long enough to capture what the page looks like now.
			win.showInactive();
			await sleep(400);
			const image = await wc.capturePage();
			win.hide();
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, image.toPNG());
		},
	};

	try {
		const timeoutMs = Number(process.env.SHELL_E2E_TIMEOUT_MS ?? 480_000);
		await Promise.race([
			require(scriptPath)(ctx),
			new Promise((_, reject) => setTimeout(() => reject(new Error(`e2e script exceeded ${timeoutMs} ms`)), timeoutMs)),
		]);
		console.log("E2E PASS");
		return 0;
	} catch (error) {
		console.error("E2E FAIL:", error?.stack ?? error);
		await ctx.screenshot(path.join(path.dirname(scriptPath), "out", "failure.png")).catch(() => {});
		return 1;
	}
}

module.exports = { runE2E };

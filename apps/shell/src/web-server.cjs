// Runs the Next.js web app as a child process and resolves once it accepts connections.
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const WEB_DIR = path.join(__dirname, "..", "..", "web");
// Browser storage (IndexedDB, OPFS) is keyed by origin, so the port must stay fixed.
const PORT = Number(process.env.SHELL_WEB_PORT ?? 43110);
const ORIGIN = `http://127.0.0.1:${PORT}`;

function isUp() {
	return new Promise((resolve) => {
		const request = http.get(`${ORIGIN}/api/health`, (response) => {
			response.resume();
			resolve(response.statusCode === 200);
		});
		request.on("error", () => resolve(false));
		request.setTimeout(2000, () => {
			request.destroy();
			resolve(false);
		});
	});
}

/** Self-contained build shipped with the installer, or null when running from the repo. */
function standaloneEntry({ production }) {
	const { app } = require("electron");
	// From the repo, `--prod` runs the staged build (see scripts/stage.cjs) when there is one.
	const staged = path.join(__dirname, "..", "staging", "web");
	const base = app.isPackaged
		? path.join(process.resourcesPath, "web")
		: (process.env.SHELL_STANDALONE_DIR ??
			(production && fs.existsSync(staged) ? staged : null));
	return base ? path.join(base, "apps", "web", "server.js") : null;
}

async function startWebServer({ production }) {
	if (await isUp()) return { origin: ORIGIN, stop: () => {} };

	const standalone = standaloneEntry({ production });
	let args;
	let cwd = WEB_DIR;
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
	if (standalone) {
		args = [standalone];
		cwd = path.dirname(standalone);
		Object.assign(env, { PORT: String(PORT), HOSTNAME: "127.0.0.1", NODE_ENV: "production" });
	} else {
		const nextBin = require.resolve("next/dist/bin/next", { paths: [WEB_DIR] });
		args = production
			? [nextBin, "start", "-H", "127.0.0.1", "-p", String(PORT)]
			: [nextBin, "dev", "--turbopack", "-H", "127.0.0.1", "-p", String(PORT)];
	}
	const child = spawn(process.execPath, args, {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let log = "";
	const collect = (chunk) => {
		log = (log + chunk).slice(-8000);
		if (process.env.SHELL_VERBOSE) process.stdout.write(chunk);
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);

	let exited = false;
	child.on("exit", () => {
		exited = true;
	});

	const deadline = Date.now() + 120_000;
	while (!(await isUp())) {
		if (exited) throw new Error(`Web server exited during startup:\n${log}`);
		if (Date.now() > deadline) {
			child.kill();
			throw new Error(`Web server did not start in time:\n${log}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 300));
	}

	// The server must never outlive the window: a leftover one would keep the port and
	// serve an old build to the next launch.
	const stop = () => {
		if (exited) return;
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
		} else {
			child.kill("SIGKILL");
		}
	};
	process.once("exit", stop);

	return { origin: ORIGIN, stop };
}

module.exports = { startWebServer, ORIGIN };

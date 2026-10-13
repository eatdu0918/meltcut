// Finds the MLT engine (melt) and runs render jobs with it.
const { app } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const EXE = process.platform === "win32" ? ".exe" : "";
const settingsPath = () => path.join(app.getPath("userData"), "shell-settings.json");

function readSettings() {
	try {
		return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
	} catch {
		return {};
	}
}

function writeSettings(patch) {
	const next = { ...readSettings(), ...patch };
	fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
	fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
	return next;
}

const hasMelt = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, `melt${EXE}`));

/**
 * Where melt lives. A folder the user picked wins, then the engine shipped with the
 * installer, then a Shotcut or Kdenlive install on this computer.
 */
function findMltBinDir() {
	const candidates = [readSettings().mltBinDir, process.env.MLT_BIN_DIR];
	if (app.isPackaged) {
		candidates.push(path.join(process.resourcesPath, "engine"));
	} else {
		const workspace = path.resolve(__dirname, "..", "..", "..", "..");
		candidates.push(
			process.env.SHELL_ENGINE_DIR,
			path.join(workspace, "bin", "shotcut", "Shotcut"),
			path.join(workspace, "bin", "kdenlive", "app", "kdenlive-26.08.1_standalone", "bin"),
		);
	}
	candidates.push(
		"C:\\Program Files\\Shotcut",
		"C:\\Program Files\\kdenlive\\bin",
		"/Applications/Shotcut.app/Contents/MacOS",
		"/usr/bin",
		"/usr/local/bin",
	);
	return candidates.find(hasMelt) ?? null;
}

function setMltBinDir(dir) {
	if (!hasMelt(dir)) return false;
	writeSettings({ mltBinDir: dir });
	return true;
}

function run(file, args, options = {}) {
	return new Promise((resolve, reject) => {
		execFile(file, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options }, (error, stdout, stderr) => {
			if (error) reject(Object.assign(error, { stdout, stderr }));
			else resolve({ stdout, stderr });
		});
	});
}

async function getStatus() {
	const binDir = findMltBinDir();
	if (!binDir) return { available: false, binDir: null, version: null };
	try {
		// melt prints its version banner on stderr.
		const { stdout, stderr } = await run(path.join(binDir, `melt${EXE}`), ["-version"]);
		const version = /melt\S*\s+([\d.]+)/i.exec(`${stdout}\n${stderr}`)?.[1] ?? null;
		return { available: true, binDir, version };
	} catch (error) {
		return { available: false, binDir, version: null, error: String(error.message ?? error) };
	}
}

// Consumer properties come from the renderer, so only plain `key=value` pairs get through.
const SAFE_KEY = /^[A-Za-z0-9_.-]+$/;
const SAFE_VALUE = /^[A-Za-z0-9_.:+,=\/ #%-]*$/;

function toConsumerArgs(properties) {
	return Object.entries(properties ?? {}).map(([key, value]) => {
		const text = String(value);
		if (!SAFE_KEY.test(key) || !SAFE_VALUE.test(text)) {
			throw new Error(`Rejected consumer property: ${key}=${text}`);
		}
		return `${key}=${text}`;
	});
}

const STALL_TIMEOUT_MS = 120_000;
const jobs = new Map();
let jobCounter = 0;

/**
 * Renders `xml` to `outputPath`. Resolves with { ok, cancelled?, error?, log } and reports
 * progress (0..1) through `onProgress`.
 */
async function render({ xml, outputPath, properties, onProgress, jobId }) {
	const binDir = findMltBinDir();
	if (!binDir) return { ok: false, error: "MLT (melt) was not found. Set its folder in the export panel." };
	if (typeof xml !== "string" || typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
		return { ok: false, error: "Invalid render request." };
	}

	const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "meltcut-"));
	const projectPath = path.join(workDir, "project.mlt");
	await fsp.writeFile(projectPath, xml, "utf8");
	await fsp.mkdir(path.dirname(outputPath), { recursive: true });

	let args;
	try {
		args = [projectPath, "-progress", "-consumer", `avformat:${outputPath}`, ...toConsumerArgs(properties)];
	} catch (error) {
		return { ok: false, error: error.message };
	}

	return new Promise((resolve) => {
		const child = spawn(path.join(binDir, `melt${EXE}`), args, {
			cwd: workDir,
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"],
		});
		const job = { child, cancelled: false };
		jobs.set(jobId, job);

		// melt reports progress continuously; long silence means it is stuck, not busy.
		let stalled = false;
		let watchdog = null;
		const armWatchdog = () => {
			clearTimeout(watchdog);
			watchdog = setTimeout(() => {
				stalled = true;
				child.kill();
			}, STALL_TIMEOUT_MS);
		};
		armWatchdog();

		let log = "";
		child.stderr.on("data", (chunk) => {
			armWatchdog();
			const text = chunk.toString();
			const matches = [...text.matchAll(/percentage:\s*(\d+)/g)];
			if (matches.length) onProgress?.(Number(matches.at(-1)[1]) / 100);
			// Keep only real messages; the progress line repeats thousands of times.
			log = (log + text.replace(/Current Frame:[^\r\n]*[\r\n]*/g, "")).slice(-6000);
		});

		const finish = async (result) => {
			clearTimeout(watchdog);
			jobs.delete(jobId);
			await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
			resolve({ ...result, log: log.trim() });
		};

		child.on("error", (error) => finish({ ok: false, error: error.message }));
		child.on("exit", async (code) => {
			if (job.cancelled) {
				await fsp.rm(outputPath, { force: true }).catch(() => {});
				return finish({ ok: false, cancelled: true });
			}
			if (stalled) {
				await fsp.rm(outputPath, { force: true }).catch(() => {});
				return finish({ ok: false, error: "The MLT renderer stopped responding and was terminated." });
			}
			const size = await fsp.stat(outputPath).then((s) => s.size, () => 0);
			if (code !== 0 || size === 0) {
				return finish({ ok: false, error: `melt exited with code ${code}${size === 0 ? " and wrote no output" : ""}` });
			}
			onProgress?.(1);
			finish({ ok: true, outputPath, size });
		});
	});
}

let frameJob = null;

/**
 * Renders one frame of `xml` as PNG bytes (JPEG shifts colours, which defeats an accuracy preview). Only the newest request matters while the
 * user scrubs, so a new call terminates the one still running.
 */
async function renderFrame({ xml, frame }) {
	const binDir = findMltBinDir();
	if (!binDir) return { ok: false, error: "MLT (melt) was not found." };
	if (typeof xml !== "string" || !Number.isInteger(frame) || frame < 0) {
		return { ok: false, error: "Invalid preview request." };
	}
	if (frameJob) {
		frameJob.superseded = true;
		frameJob.child.kill();
	}

	const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "meltcut-frame-"));
	const projectPath = path.join(workDir, "project.mlt");
	const imagePath = path.join(workDir, "frame.png");
	await fsp.writeFile(projectPath, xml, "utf8");

	return new Promise((resolve) => {
		const child = spawn(
			path.join(binDir, `melt${EXE}`),
			[projectPath, `in=${frame}`, `out=${frame}`, "-quiet", "-consumer", `avformat:${imagePath}`, "vcodec=png", "an=1"],
			{ cwd: workDir, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
		);
		const job = { child, superseded: false };
		frameJob = job;
		let log = "";
		child.stderr.on("data", (chunk) => {
			log = (log + chunk).slice(-2000);
		});
		const timer = setTimeout(() => child.kill(), 30_000);

		const finish = async (result) => {
			clearTimeout(timer);
			if (frameJob === job) frameJob = null;
			await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
			resolve(result);
		};
		child.on("error", (error) => finish({ ok: false, error: error.message }));
		child.on("exit", async (code) => {
			if (job.superseded) return finish({ ok: false, superseded: true });
			const data = await fsp.readFile(imagePath).catch(() => null);
			if (code !== 0 || !data?.length) {
				return finish({ ok: false, error: `melt could not render the frame (code ${code}). ${log.trim()}` });
			}
			finish({ ok: true, data });
		});
	});
}

const MAX_PREVIEW_CLIP_BYTES = 400 * 1024 * 1024;

/** Renders the whole project as a small, fast-to-encode MP4 and returns its bytes. */
async function renderPreviewClip({ xml, jobId, onProgress }) {
	const outputPath = path.join(os.tmpdir(), `meltcut-preview-${process.pid}-${jobId}.mp4`);
	const result = await render({
		xml,
		jobId,
		outputPath,
		onProgress,
		properties: {
			f: "mp4",
			vcodec: "libx264",
			preset: "ultrafast",
			crf: 28,
			pix_fmt: "yuv420p",
			acodec: "aac",
			ab: "128k",
			movflags: "+faststart",
		},
	});
	if (!result.ok) return result;
	try {
		if (result.size > MAX_PREVIEW_CLIP_BYTES) {
			return { ok: false, error: "The preview is too large to load. Export the project instead." };
		}
		return { ok: true, data: await fsp.readFile(outputPath) };
	} finally {
		await fsp.rm(outputPath, { force: true }).catch(() => {});
	}
}

function cancel(jobId) {
	const job = jobs.get(jobId);
	if (!job) return false;
	job.cancelled = true;
	job.child.kill();
	return true;
}

function cancelAll() {
	for (const jobId of jobs.keys()) cancel(jobId);
	frameJob?.child.kill();
}

const nextJobId = () => `job-${++jobCounter}`;

module.exports = { getStatus, findMltBinDir, setMltBinDir, render, renderFrame, renderPreviewClip, cancel, cancelAll, nextJobId, run, EXE };

// Gathers everything the installer ships besides the shell itself into `staging/`:
//   staging/web     the built web app, runnable with plain Node
//   staging/engine  the MLT engine (melt, ffmpeg and their libraries)
//
// Usage: node scripts/stage.cjs [--engine=<folder containing melt>]
// Run `next build` in apps/web first.
const fs = require("node:fs");
const path = require("node:path");

const shellDir = path.resolve(__dirname, "..");
const repoDir = path.resolve(shellDir, "..", "..");
const webDir = path.join(repoDir, "apps", "web");
const stagingDir = path.join(shellDir, "staging");

const engineArg = process.argv.find((arg) => arg.startsWith("--engine="));
const engineSource = path.resolve(
	engineArg?.slice("--engine=".length) ??
		process.env.MELTCUT_ENGINE_DIR ??
		path.join(repoDir, "..", "bin", "shotcut", "Shotcut"),
);

// Parts of a Shotcut install that only its own window needs.
const ENGINE_SKIP = new Set(
	["shotcut.exe", "ffplay.exe", "gopro2gpx.exe", "whisper-cli.exe", "share/shotcut", "share/translations"].map((p) =>
		p.replaceAll("/", path.sep),
	),
);

function copyDir(from, to, skip = () => false) {
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		if (skip(source)) continue;
		if (entry.isDirectory()) copyDir(source, target, skip);
		else if (entry.isFile()) fs.copyFileSync(source, target);
	}
}

function fail(message) {
	console.error(`stage: ${message}`);
	process.exit(1);
}

fs.rmSync(stagingDir, { recursive: true, force: true });

// --- web app ---
const standalone = path.join(webDir, ".next", "standalone");
const serverEntry = path.join(standalone, "apps", "web", "server.js");
if (!fs.existsSync(serverEntry)) {
	fail(`no standalone build at ${serverEntry}. Run "next build" in apps/web first.`);
}
const stagedWeb = path.join(stagingDir, "web");
copyDir(standalone, stagedWeb);
// The standalone output leaves these two for the deployer to place next to server.js.
copyDir(path.join(webDir, ".next", "static"), path.join(stagedWeb, "apps", "web", ".next", "static"));
copyDir(path.join(webDir, "public"), path.join(stagedWeb, "apps", "web", "public"));

// --- engine ---
const exe = process.platform === "win32" ? ".exe" : "";
if (!fs.existsSync(path.join(engineSource, `melt${exe}`))) {
	fail(`no melt in ${engineSource}. Pass --engine=<folder> pointing at a Shotcut install.`);
}
copyDir(path.join(engineSource), path.join(stagingDir, "engine"), (source) =>
	ENGINE_SKIP.has(path.relative(engineSource, source)),
);

const sizeOf = (dir) => {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		total += entry.isDirectory() ? sizeOf(full) : fs.statSync(full).size;
	}
	return total;
};
for (const name of ["web", "engine"]) {
	console.log(`staged ${name}: ${(sizeOf(path.join(stagingDir, name)) / 1e6).toFixed(0)} MB`);
}

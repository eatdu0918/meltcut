// Builds the Windows installer: stages the web app and engine, then runs electron-builder.
//
// Usage: node scripts/dist.cjs [--engine=<folder containing melt>] [--dir]
//   --dir   build only the unpacked app folder (faster; no installer)
//
// electron-builder needs a newer Node than some machines have, so it runs on the Node
// that ships inside Electron.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const shellDir = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

const stage = spawnSync(
	process.execPath,
	[path.join(__dirname, "stage.cjs"), ...args.filter((arg) => arg.startsWith("--engine="))],
	{ cwd: shellDir, stdio: "inherit" },
);
if (stage.status !== 0) process.exit(stage.status ?? 1);

const electron = require("electron");
const builderCli = path.join(__dirname, "run-builder.cjs");
const target = args.includes("--dir") ? "dir" : "nsis";
const build = spawnSync(electron, [builderCli, "--win", target, "--x64"], {
	cwd: shellDir,
	stdio: "inherit",
	env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
process.exit(build.status ?? 1);

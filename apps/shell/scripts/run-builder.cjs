// Entry point for electron-builder when it runs on Electron's Node (see dist.cjs).
// Argument parsers treat an Electron process as a packaged app and keep argv[1]; drop this
// script's own path so only the real arguments remain.
process.argv.splice(1, 1);
// Electron's Node opens .asar archives as folders, which breaks a tool that writes them.
process.noAsar = true;
require("electron-builder/cli.js");

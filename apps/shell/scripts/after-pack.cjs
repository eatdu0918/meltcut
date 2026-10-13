// electron-builder hook: copies the staged web app into the packaged app's resources.
//
// The web app is a self-contained Node server with its own `node_modules`, and
// electron-builder drops every `node_modules` folder from `extraResources`. Copying it here,
// after packing and before the installer is made, keeps it whole.
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
	const source = path.join(context.packager.projectDir, "staging", "web");
	const target = path.join(context.appOutDir, "resources", "web");
	if (!fs.existsSync(path.join(source, "apps", "web", "server.js"))) {
		throw new Error(`No staged web app at ${source}. Run scripts/stage.cjs first.`);
	}
	fs.rmSync(target, { recursive: true, force: true });
	fs.cpSync(source, target, { recursive: true });
};

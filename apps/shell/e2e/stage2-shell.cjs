// Stage 2: the shell boots the editor offline and imported media keeps its on-disk path.
const path = require("node:path");
const { OUT_DIR, createProject, importMedia, readStore, assert } = require("./helpers.cjs");

module.exports = async (ctx) => {
	assert(await ctx.exec(`return window.desktop?.isDesktop === true`), "desktop bridge is exposed");

	const projectId = await createProject(ctx);
	const files = await importMedia(ctx, ["clipA.mp4", "clipB.mp4"]);

	const dbName = `video-editor-media-${projectId}`;
	const rows = await ctx.waitFor(
		`(async () => { ${readStore(dbName, "media-metadata")} })().then((r) => r.length === 2 ? r.map(({ name, filePath, duration }) => ({ name, filePath, duration })) : null)`,
		{ label: "two media assets saved" },
	);

	for (const file of files) {
		const row = rows.find((r) => r.name === path.basename(file));
		assert(row, `${path.basename(file)} was imported`);
		assert(row.filePath === file, `${row.name} keeps its path (got ${row.filePath})`);
		assert(await ctx.exec(`return window.desktop.fileExists(${JSON.stringify(row.filePath)})`), `${row.name} path exists on disk`);
	}

	// Nothing may reach out to the network: the app has to work offline.
	const external = await ctx.exec(`
		return performance.getEntriesByType("resource")
			.map((entry) => entry.name)
			.filter((url) => /^https?:/.test(url) && !url.startsWith(location.origin));
	`);
	assert(external.length === 0, `no external requests (got ${external.join(", ")})`);

	await ctx.sleep(1000);
	await ctx.screenshot(path.join(OUT_DIR, "stage2-editor.png"));
	console.log("media rows:", JSON.stringify(rows));
	console.log("console errors:", JSON.stringify(ctx.consoleErrors.slice(0, 5)));
};

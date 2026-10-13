// Stage 5: a project survives being saved to a file and opened again as a new project.
const fs = require("node:fs");
const path = require("node:path");
const { OUT_DIR, TEST_MEDIA_DIR, createProject, importMedia, assert } = require("./helpers.cjs");

/** Colours of a few MLT-rendered pixels: enough to tell two renders of the timeline apart. */
const fingerprint = `
	await (async () => {
		const points = [];
		for (const seconds of [0.2, 2]) {
			const result = await window.__e2e.compareWithMlt({ seconds });
			const image = new Image();
			image.src = result.mltPng;
			await image.decode();
			const canvas = document.createElement("canvas");
			canvas.width = image.width;
			canvas.height = image.height;
			const context = canvas.getContext("2d");
			context.drawImage(image, 0, 0);
			for (const [x, y] of [[100, 100], [640, 360], [1000, 100], [300, 600]]) {
				points.push([...context.getImageData(x, y, 1, 1).data].slice(0, 3));
			}
			if (result.warnings.length) points.push("warnings: " + result.warnings.join("; "));
		}
		return points;
	})()
`.trim();

const describeTimeline = `
	(() => {
		const { editor } = window.__e2e;
		const tracks = editor.scenes.getActiveScene().tracks;
		return {
			name: editor.project.getActive().metadata.name,
			elements: [tracks.main, ...tracks.overlay].flatMap((track) => track.elements.map((e) => ({
				name: e.name,
				type: e.type,
				start: e.startTime,
				duration: e.duration,
				fadeIn: e.params["transition.in.type"] ?? null,
				effects: (e.effects ?? []).map((fx) => fx.type),
			}))),
			media: editor.media.getAssets().map((a) => ({ name: a.name, filePath: a.filePath })),
		};
	})()
`.trim();

module.exports = async (ctx) => {
	fs.mkdirSync(OUT_DIR, { recursive: true });
	const originalId = await createProject(ctx);
	await importMedia(ctx, ["clipC.mp4"]);
	await ctx.waitFor(`window.__e2e && window.__e2e.editor.media.getAssets().length === 1`, { label: "asset loaded" });
	await ctx.exec(`
		const { editor, buildElementFromMedia, buildTextElement, mediaTimeFromSeconds } = window.__e2e;
		const t = (seconds) => mediaTimeFromSeconds({ seconds });
		const asset = editor.media.getAssets()[0];
		editor.timeline.insertElement({ element: buildElementFromMedia({ mediaId: asset.id, mediaType: asset.type, name: asset.name, duration: t(6), startTime: t(0) }), placement: { mode: "auto" } });
		editor.timeline.insertElement({ element: buildTextElement({ raw: { name: "Title", duration: t(5), params: { content: "Saved", fontSize: 14 } }, startTime: t(0) }), placement: { mode: "auto" } });
		const main = editor.scenes.getActiveScene().tracks.main;
		const ref = { trackId: main.id, elementId: main.elements[0].id };
		editor.timeline.addClipEffect({ ...ref, effectType: "mlt.sepia" });
		editor.timeline.updateElements({ updates: [{ ...ref, patch: { params: { "transition.in.type": "fade", "transition.in.seconds": 1 } } }] });
		return true;
	`);
	const before = { timeline: await ctx.exec(`return ${describeTimeline}`), pixels: await ctx.exec(`return ${fingerprint}`) };

	// --- Save ---
	const projectFile = path.join(OUT_DIR, "stage5-project.meltcut");
	fs.rmSync(projectFile, { force: true });
	ctx.queueDialogAnswer(projectFile);
	const savedTo = await ctx.exec(`return window.__e2e.saveProjectFile()`);
	assert(savedTo === projectFile, `saved to the chosen path (${savedTo})`);
	const saved = JSON.parse(fs.readFileSync(projectFile, "utf8"));
	assert(saved.format === "meltcut-project" && saved.version === 1, "file is tagged with its format and version");
	assert(saved.media.length === 1 && saved.media[0].filePath === path.join(TEST_MEDIA_DIR, "clipC.mp4"), `file lists media by path (${JSON.stringify(saved.media)})`);
	assert(!JSON.stringify(saved).includes("data:image"), "no thumbnails or other bulky data in the file");
	assert(fs.statSync(projectFile).size < 200_000, `file stays small (${fs.statSync(projectFile).size} bytes)`);

	// --- Open as a new project, through the button on the projects page ---
	await ctx.goto("/projects");
	await ctx.waitFor(`document.querySelector('[data-testid="open-project-file"]')`, { label: "Open file button" });
	await ctx.screenshot(path.join(OUT_DIR, "stage5-projects-page.png"));
	ctx.queueDialogAnswer(projectFile);
	const deadline = Date.now() + 60_000;
	while (!(await ctx.exec(`return location.pathname.startsWith("/editor/")`))) {
		if (Date.now() > deadline) throw new Error("Timed out opening the project file");
		await ctx.exec(`document.querySelector('[data-testid="open-project-file"]')?.click()`);
		await ctx.sleep(1500);
	}
	const openedId = await ctx.exec(`return location.pathname.split("/").pop()`);
	assert(openedId !== originalId, "the file opens as a new project, leaving the original alone");
	await ctx.waitFor(`window.__e2e && window.__e2e.editor.media.getAssets().length === 1 && window.__e2e.editor.scenes.getActiveSceneOrNull()?.tracks.main.elements.length === 1`, { label: "opened project loaded", timeout: 60_000 });

	const after = { timeline: await ctx.exec(`return ${describeTimeline}`), pixels: await ctx.exec(`return ${fingerprint}`) };
	assert(JSON.stringify(after.timeline) === JSON.stringify(before.timeline), `timeline, effects, transitions and media paths survive\n  before ${JSON.stringify(before.timeline)}\n  after  ${JSON.stringify(after.timeline)}`);
	const maxDelta = Math.max(...before.pixels.flatMap((pixel, i) => (Array.isArray(pixel) ? pixel.map((channel, c) => Math.abs(channel - after.pixels[i][c])) : [pixel === after.pixels[i] ? 0 : 255])));
	assert(maxDelta <= 3, `melt renders the reopened project the same (max channel difference ${maxDelta})`);
	console.log("  ok save and reopen");

	// --- A project whose media has moved still opens, and says what is missing ---
	const movedFile = path.join(OUT_DIR, "stage5-project-moved.meltcut");
	fs.writeFileSync(movedFile, JSON.stringify({ ...saved, media: [{ ...saved.media[0], filePath: path.join(OUT_DIR, "does-not-exist.mp4") }] }));
	await ctx.goto("/projects");
	await ctx.waitFor(`document.querySelector('[data-testid="open-project-file"]')`, { label: "Open file button" });
	ctx.queueDialogAnswer(movedFile);
	const movedDeadline = Date.now() + 60_000;
	let sawWarning = false;
	while (!(await ctx.exec(`return location.pathname.startsWith("/editor/")`))) {
		if (Date.now() > movedDeadline) throw new Error("Timed out opening the project with moved media");
		await ctx.exec(`document.querySelector('[data-testid="open-project-file"]')?.click()`);
		await ctx.sleep(1500);
		sawWarning ||= await ctx.exec(`return document.body.innerText.includes("Some media files were not found")`);
	}
	sawWarning ||= await ctx.exec(`return document.body.innerText.includes("Some media files were not found")`);
	assert(sawWarning, "the user is told which media was not found");
	console.log("  ok missing media reported");

	// --- Something that is not a project file is refused ---
	const bogus = path.join(OUT_DIR, "stage5-not-a-project.meltcut");
	fs.writeFileSync(bogus, JSON.stringify({ hello: "world" }));
	await ctx.goto("/projects");
	await ctx.waitFor(`document.querySelector('[data-testid="open-project-file"]')`, { label: "Open file button" });
	ctx.queueDialogAnswer(bogus);
	await ctx.sleep(1500);
	await ctx.exec(`document.querySelector('[data-testid="open-project-file"]').click()`);
	await ctx.waitFor(`document.body.innerText.includes("This is not a project file")`, { label: "refusal message" });
	assert(await ctx.exec(`return location.pathname === "/projects"`), "a refused file leaves the projects page as it was");
	console.log("  ok invalid file refused");
};

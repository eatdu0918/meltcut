// Stage 6: a transition on a clip that touches its neighbour plays between the two clips.
const fs = require("node:fs");
const { OUT_DIR, createProject, importMedia, assert } = require("./helpers.cjs");

/** Colour of the MLT frame at project pixel (x, y) at `seconds`. */
const mltPixel = (seconds, x, y) => `
	await (async () => {
		const result = await window.__e2e.compareWithMlt({ seconds: ${seconds} });
		if (result.warnings.length) throw new Error("warnings: " + result.warnings.join("; "));
		const image = new Image();
		image.src = result.mltPng;
		await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext("2d");
		context.drawImage(image, 0, 0);
		return [...context.getImageData(${x}, ${y}, 1, 1).data].slice(0, 3);
	})()
`.trim();

module.exports = async (ctx) => {
	fs.mkdirSync(OUT_DIR, { recursive: true });
	await createProject(ctx);
	await importMedia(ctx, ["clipC.mp4", "clipB.mp4"]);
	await ctx.waitFor(`window.__e2e && window.__e2e.editor.media.getAssets().length === 2`, { label: "assets loaded" });

	// clipC (colour bars) for two seconds, then clipB right after it on the same track,
	// turned upside down so the two are easy to tell apart at one pixel.
	const placed = await ctx.exec(`
		const { editor, buildElementFromMedia, mediaTimeFromSeconds } = window.__e2e;
		const t = (seconds) => mediaTimeFromSeconds({ seconds });
		const add = (name, start) => {
			const asset = editor.media.getAssets().find((a) => a.name === name);
			editor.timeline.insertElement({
				element: buildElementFromMedia({ mediaId: asset.id, mediaType: asset.type, name: asset.name, duration: t(2), startTime: t(start) }),
				placement: { mode: "explicit", trackId: editor.scenes.getActiveScene().tracks.main.id },
			});
		};
		add("clipC.mp4", 0);
		add("clipB.mp4", 2);
		const main = editor.scenes.getActiveScene().tracks.main;
		const second = main.elements.find((e) => e.name === "clipB.mp4");
		editor.timeline.updateElements({ updates: [{ trackId: main.id, elementId: second.id, patch: { params: { "transform.rotate": 180 } } }] });
		return main.elements.map((e) => [e.name, e.startTime, e.duration]);
	`);
	console.log("  main track:", JSON.stringify(placed));
	assert(placed.length === 2, "both clips are on the main track");

	// (100,100) is the grey bar of clipC, and (after the half turn) the dark bottom row of clipB.
	const before = await ctx.exec(`return ${mltPixel(1, 100, 100)}`);
	const hardCut = await ctx.exec(`return ${mltPixel(2.0, 100, 100)}`);
	const after = await ctx.exec(`return ${mltPixel(3.5, 100, 100)}`);
	console.log("  without a transition:", JSON.stringify({ before, hardCut, after }));
	assert(before[0] > 180, `the first clip shows its grey bar (${before})`);
	assert(hardCut[0] < 60 && after[0] < 60, `the second clip is dark there (${hardCut}, ${after})`);

	await ctx.exec(`
		const { editor } = window.__e2e;
		const main = editor.scenes.getActiveScene().tracks.main;
		const second = main.elements.find((e) => e.name === "clipB.mp4");
		editor.timeline.updateElements({ updates: [{ trackId: main.id, elementId: second.id, patch: { params: { "transition.in.type": "fade", "transition.in.seconds": 1 } } }] });
		return true;
	`);
	const atCut = await ctx.exec(`return ${mltPixel(2.0, 100, 100)}`);
	const halfWay = await ctx.exec(`return ${mltPixel(2.5, 100, 100)}`);
	const done = await ctx.exec(`return ${mltPixel(3.5, 100, 100)}`);
	console.log("  with a fade in:", JSON.stringify({ atCut, halfWay, done }));
	assert(atCut[0] > 180, `at the cut the first clip is still there, not the background (${atCut})`);
	assert(halfWay[0] > 70 && halfWay[0] < 140, `half way the two clips are mixed (${halfWay})`);
	assert(done[0] < 60, `afterwards only the second clip shows (${done})`);

	const errors = ctx.consoleErrors.filter((message) => !/cannot be a descendant of|cannot contain a nested/.test(message));
	assert(errors.length === 0, `no console errors (${errors.slice(0, 3).join(" | ").slice(0, 400)})`);
};

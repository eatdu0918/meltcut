// Stage 5: MLT-only effects are offered by the editor, stored on clips, and rendered by melt.
const fs = require("node:fs");
const path = require("node:path");
const { OUT_DIR, createProject, importMedia, assert } = require("./helpers.cjs");

const pixelOf = (dataUrlVar) => `
	await (async () => {
		const image = new Image();
		image.src = ${dataUrlVar};
		await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = image.width;
		canvas.height = image.height;
		const context = canvas.getContext("2d");
		context.drawImage(image, 0, 0);
		return [...context.getImageData(1000, 100, 1, 1).data].slice(0, 3);
	})()
`;

module.exports = async (ctx) => {
	fs.mkdirSync(OUT_DIR, { recursive: true });
	await createProject(ctx);
	await importMedia(ctx, ["clipC.mp4"]);
	await ctx.waitFor(`window.__e2e && window.__e2e.editor.media.getAssets().length === 1`, { label: "asset loaded" });
	await ctx.exec(`
		const { editor, buildElementFromMedia, mediaTimeFromSeconds } = window.__e2e;
		const asset = editor.media.getAssets()[0];
		editor.timeline.insertElement({
			element: buildElementFromMedia({ mediaId: asset.id, mediaType: asset.type, name: asset.name, duration: mediaTimeFromSeconds({ seconds: 6 }), startTime: mediaTimeFromSeconds({ seconds: 0 }) }),
			placement: { mode: "auto" },
		});
		return true;
	`);

	// The Effects panel lists the MLT catalog next to the editor's own blur.
	await ctx.exec(`[...document.querySelectorAll('[aria-label]')].find((el) => el.getAttribute("aria-label") === "Effects")?.click(); return true;`);
	await ctx.waitFor(`document.body.innerText.includes("Black & white") && document.body.innerText.includes("Chroma key")`, { label: "MLT effects listed in the Effects panel" });
	await ctx.screenshot(path.join(OUT_DIR, "stage5-effects-panel.png"));

	// Add one through the editor's own command, as the panel does.
	const before = await ctx.exec(`
		const result = await window.__e2e.compareWithMlt({ seconds: 1 });
		return { editor: ${pixelOf("result.editorPng")}, mlt: ${pixelOf("result.mltPng")} };
	`);
	assert(before.mlt[0] > 150 && before.mlt[1] < 80, `the sampled bar starts out red (${before.mlt})`);

	await ctx.exec(`
		const { editor } = window.__e2e;
		const main = editor.scenes.getActiveScene().tracks.main;
		editor.timeline.addClipEffect({ trackId: main.id, elementId: main.elements[0].id, effectType: "mlt.grayscale" });
		return true;
	`);
	await ctx.sleep(500);
	const after = await ctx.exec(`
		const result = await window.__e2e.compareWithMlt({ seconds: 1 });
		return { editor: ${pixelOf("result.editorPng")}, mlt: ${pixelOf("result.mltPng")}, warnings: result.warnings };
	`);
	assert(after.warnings.length === 0, `no conversion warnings (${after.warnings})`);
	const spread = (pixel) => Math.max(...pixel) - Math.min(...pixel);
	assert(spread(after.mlt) < 14, `melt renders the clip in black and white (${after.mlt})`);
	assert(spread(after.editor) > 100, `the real-time preview leaves the clip unchanged, as documented (${after.editor})`);

	// The properties panel shows the effect's controls, and the editor keeps running.
	await ctx.exec(`
		const { editor } = window.__e2e;
		const main = editor.scenes.getActiveScene().tracks.main;
		editor.selection.setSelectedElements({ elements: [{ trackId: main.id, elementId: main.elements[0].id }] });
		return true;
	`);
	await ctx.sleep(500);
	await ctx.screenshot(path.join(OUT_DIR, "stage5-effects-properties.png"));

	// The MLT preview overlay shows the effect in the editor itself.
	await ctx.exec(`document.querySelector('[data-testid="mlt-preview-toggle"]').click()`);
	await ctx.waitFor(`(() => { const img = document.querySelector('[data-testid="mlt-preview-frame"]'); return img && img.complete && img.naturalWidth > 0; })()`, { label: "MLT preview frame", timeout: 20_000 });
	await ctx.sleep(300);
	await ctx.screenshot(path.join(OUT_DIR, "stage5-effects-preview.png"));

	// The editor's own timeline clip nests a button in a button when a clip has effects; React
	// warns about that in development. It predates the MLT work and is not what this checks.
	const errors = ctx.consoleErrors.filter((message) => !/cannot be a descendant of|cannot contain a nested/.test(message));
	assert(errors.length === 0, `no console errors (${errors.slice(0, 3).join(" | ").slice(0, 400)})`);
};

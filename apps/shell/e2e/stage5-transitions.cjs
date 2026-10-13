// Stage 5: transitions set in the editor are stored on the clip and rendered by melt.
const fs = require("node:fs");
const path = require("node:path");
const { OUT_DIR, createProject, importMedia, assert } = require("./helpers.cjs");

/** Brightness of the MLT frame at project pixel (x, y), 0..255, at `seconds`. */
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
	await importMedia(ctx, ["clipC.mp4"]);
	await ctx.waitFor(`window.__e2e && window.__e2e.editor.media.getAssets().length === 1`, { label: "asset loaded" });
	await ctx.exec(`
		const { editor, buildElementFromMedia, buildTextElement, mediaTimeFromSeconds } = window.__e2e;
		const asset = editor.media.getAssets()[0];
		editor.timeline.insertElement({
			element: buildElementFromMedia({ mediaId: asset.id, mediaType: asset.type, name: asset.name, duration: mediaTimeFromSeconds({ seconds: 6 }), startTime: mediaTimeFromSeconds({ seconds: 0 }) }),
			placement: { mode: "auto" },
		});
		editor.timeline.insertElement({
			element: buildTextElement({ raw: { name: "Title", duration: mediaTimeFromSeconds({ seconds: 4 }), params: { content: "MMMMMMMM", fontSize: 14 } }, startTime: mediaTimeFromSeconds({ seconds: 1 }) }),
			placement: { mode: "auto" },
		});
		return true;
	`);

	// The Transitions tab asks for a selection first.
	await ctx.exec(`window.__e2e.editor.selection.setSelectedElements({ elements: [] }); return true;`);
	await ctx.exec(`[...document.querySelectorAll('[aria-label]')].find((el) => el.getAttribute("aria-label") === "Transitions")?.click(); return true;`);
	await ctx.waitFor(`document.body.innerText.includes("Select a clip on the timeline")`, { label: "empty-selection hint" });

	const select = (name) => `
		const { editor } = window.__e2e;
		const tracks = editor.scenes.getActiveScene().tracks;
		for (const track of [tracks.main, ...tracks.overlay]) {
			const element = track.elements.find((e) => e.name === ${JSON.stringify(name)});
			if (element) {
				editor.selection.setSelectedElements({ elements: [{ trackId: track.id, elementId: element.id }] });
				return { trackId: track.id, elementId: element.id };
			}
		}
		throw new Error("not found");
	`;
	const setParams = (name, params) => `
		const ref = await (async () => { ${select(name)} })();
		window.__e2e.editor.timeline.updateElements({ updates: [{ ...ref, patch: { params: ${JSON.stringify(params)} } }] });
		return true;
	`;

	await ctx.exec(select("clipC.mp4"));
	await ctx.waitFor(`document.querySelector('[data-testid="transitions-view"]')`, { label: "transition controls for the selected clip" });
	assert(await ctx.exec(`return document.querySelector('[data-testid="transition-in-type"]').innerText.trim() === "None"`), "a new clip has no transition");

	// Video clip: fade in over one second. (100,100) is the grey bar: 191 when fully shown.
	await ctx.exec(setParams("clipC.mp4", { "transition.in.type": "fade", "transition.in.seconds": 1 }));
	await ctx.waitFor(`document.querySelector('[data-testid="transition-in-type"]').innerText.trim() === "Fade"`, { label: "controls show the stored transition" });
	await ctx.screenshot(path.join(OUT_DIR, "stage5-transitions-panel.png"));

	const start = await ctx.exec(`return ${mltPixel(0, 100, 100)}`);
	const middle = await ctx.exec(`return ${mltPixel(0.5, 100, 100)}`);
	const shown = await ctx.exec(`return ${mltPixel(2, 100, 100)}`);
	assert(start[0] < 12, `fade starts from the background (${start})`);
	assert(middle[0] > 70 && middle[0] < 125, `fade is half way after half its length (${middle})`);
	assert(shown[0] > 180, `clip is fully shown after the fade (${shown})`);

	// Undo removes it again: transitions are ordinary edits.
	await ctx.exec(`window.__e2e.editor.command.undo(); return true;`);
	await ctx.waitFor(`document.querySelector('[data-testid="transition-in-type"]').innerText.trim() === "None"`, { label: "undo clears the transition" });
	const undone = await ctx.exec(`return ${mltPixel(0, 100, 100)}`);
	assert(undone[0] > 180, `after undo the clip shows from its first frame (${undone})`);

	// Text: slides in from the left, so early on its right half has not arrived.
	// The text sits around the centre row; white glyph pixels are counted on that row.
	const whiteOnRow = (seconds, fromX, toX) => `
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
			let count = 0;
			for (let y = 320; y < 400; y += 4) {
				const row = context.getImageData(${fromX}, y, ${toX} - ${fromX}, 1).data;
				for (let i = 0; i < row.length; i += 4) if (row[i] > 240 && row[i + 1] > 240 && row[i + 2] > 240) count++;
			}
			return count;
		})()
	`.trim();
	await ctx.exec(setParams("Title", { "transition.in.type": "slide-left", "transition.in.seconds": 1 }));
	const settledRight = await ctx.exec(`return ${whiteOnRow(3, 700, 1000)}`);
	const earlyRight = await ctx.exec(`return ${whiteOnRow(1.07, 700, 1000)}`);
	assert(settledRight > 300, `the settled title covers the right of centre (${settledRight})`);
	assert(earlyRight < settledRight / 5, `early in the slide the title has not reached there (${earlyRight} vs ${settledRight})`);

	const errors = ctx.consoleErrors.filter((message) => !/cannot be a descendant of|cannot contain a nested/.test(message));
	assert(errors.length === 0, `no console errors (${errors.slice(0, 3).join(" | ").slice(0, 400)})`);
};

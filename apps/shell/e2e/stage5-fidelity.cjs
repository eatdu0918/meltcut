// Stage 5: what the editor shows and what melt renders are the same picture.
// Every case draws one instant with both engines at full size and compares the pixels.
const fs = require("node:fs");
const path = require("node:path");
const { OUT_DIR, createProject, importMedia, assert } = require("./helpers.cjs");

// clipC is a still, colour-tagged (BT.709) test card, so a frame-timing difference between the engines cannot hide a real one.
const setup = `
	const { editor, buildElementFromMedia, mediaTimeFromSeconds } = window.__e2e;
	const asset = editor.media.getAssets().find((a) => a.name === "clipC.mp4");
	editor.timeline.insertElement({
		element: buildElementFromMedia({ mediaId: asset.id, mediaType: asset.type, name: asset.name, duration: mediaTimeFromSeconds({ seconds: 6 }), startTime: mediaTimeFromSeconds({ seconds: 0 }) }),
		placement: { mode: "auto" },
	});
	return true;
`;

/** Runs page code with the e2e helpers in scope, plus lookups for the elements added so far. */
const withHelpers = (body) => `
	const { editor, buildTextElement, buildGraphicElement, mediaTimeFromSeconds } = window.__e2e;
	const t = (seconds) => mediaTimeFromSeconds({ seconds });
	const tracks = () => editor.scenes.getActiveScene().tracks;
	const find = (name) => {
		for (const track of [tracks().main, ...tracks().overlay]) {
			const element = track.elements.find((e) => e.name === name);
			if (element) return { trackId: track.id, elementId: element.id, element };
		}
		throw new Error("no element named " + name);
	};
	const update = (name, params) => {
		const { trackId, elementId } = find(name);
		editor.timeline.updateElements({ updates: [{ trackId, elementId, patch: { params } }] });
	};
	${body}
	return true;
`;

const cases = [
	{
		name: "video-only",
		at: 1,
		run: ``,
	},
	{
		name: "text-default",
		at: 1,
		run: `editor.timeline.insertElement({ element: buildTextElement({ raw: { name: "Title", params: { content: "Hello MLT", fontSize: 12 } }, startTime: t(0) }), placement: { mode: "auto" } });`,
	},
	{
		name: "text-styled-moved",
		at: 1,
		run: `update("Title", { content: "Styled text gj", fontSize: 8, color: "#ffdd00", fontWeight: "bold", "background.enabled": true, "background.color": "#102080", "transform.positionX": -250, "transform.positionY": 180, "transform.rotate": -12, opacity: 0.85 });`,
	},
	{
		name: "shape-rectangle",
		at: 1,
		run: `editor.timeline.insertElement({ element: buildGraphicElement({ definitionId: "rectangle", name: "Box", startTime: t(0), params: { "transform.positionX": 300, "transform.positionY": -150, "transform.scaleX": 0.6, "transform.scaleY": 0.6, "transform.rotate": 20 } }), placement: { mode: "auto" } });`,
	},
	{
		name: "video-transformed",
		at: 1,
		run: `update("clipC.mp4", { "transform.positionX": 120, "transform.positionY": 60, "transform.scaleX": 0.7, "transform.scaleY": 0.7, "transform.rotate": 8, opacity: 0.9 });`,
	},
	{
		name: "text-keyframed-position",
		at: 1.5,
		run: `
			const { trackId, elementId } = find("Title");
			editor.timeline.upsertKeyframes({ keyframes: [
				{ trackId, elementId, propertyPath: "transform.positionX", time: t(0), value: -400 },
				{ trackId, elementId, propertyPath: "transform.positionX", time: t(3), value: 400 },
				{ trackId, elementId, propertyPath: "opacity", time: t(0), value: 0.2 },
				{ trackId, elementId, propertyPath: "opacity", time: t(3), value: 1 },
			] });
		`,
	},
	{
		name: "video-keyframed-scale",
		at: 2,
		run: `
			const { trackId, elementId } = find("clipC.mp4");
			editor.timeline.upsertKeyframes({ keyframes: [
				{ trackId, elementId, propertyPath: "transform.scaleX", time: t(0), value: 0.4 },
				{ trackId, elementId, propertyPath: "transform.scaleX", time: t(4), value: 1 },
				{ trackId, elementId, propertyPath: "transform.scaleY", time: t(0), value: 0.4 },
				{ trackId, elementId, propertyPath: "transform.scaleY", time: t(4), value: 1 },
				{ trackId, elementId, propertyPath: "transform.rotate", time: t(0), value: 0 },
				{ trackId, elementId, propertyPath: "transform.rotate", time: t(4), value: 45 },
			] });
		`,
	},
	{
		name: "video-masked-ellipse",
		at: 1,
		run: `
			const { trackId, elementId } = find("clipC.mp4");
			const mask = window.__e2e.buildDefaultMaskInstance({ maskType: "ellipse", elementSize: { width: 1280, height: 720 } });
			editor.timeline.updateElements({ updates: [{ trackId, elementId, patch: { masks: [mask] } }] });
		`,
	},
	{
		name: "video-masked-star-inverted",
		at: 1,
		run: `
			const { trackId, elementId } = find("clipC.mp4");
			const mask = window.__e2e.buildDefaultMaskInstance({ maskType: "star", elementSize: { width: 1280, height: 720 } });
			mask.params.inverted = true;
			mask.params.feather = 30;
			editor.timeline.updateElements({ updates: [{ trackId, elementId, patch: { masks: [mask] } }] });
		`,
	},
	{
		name: "video-blur-effect",
		at: 1,
		run: `
			const { trackId, elementId } = find("clipC.mp4");
			editor.timeline.addClipEffect({ trackId, elementId, effectType: "blur" });
		`,
	},
	{
		name: "text-keyframed-colour",
		at: 1.5,
		run: `
			editor.timeline.insertElement({ element: buildTextElement({ raw: { name: "Fading", params: { content: "Colour", fontSize: 10, "background.enabled": true, "background.color": "#000000", "transform.positionY": -260 } }, startTime: t(0) }), placement: { mode: "auto" } });
			const { trackId, elementId } = find("Fading");
			editor.timeline.upsertKeyframes({ keyframes: [
				{ trackId, elementId, propertyPath: "color", time: t(0), value: "#ff0000" },
				{ trackId, elementId, propertyPath: "color", time: t(3), value: "#0000ff" },
				{ trackId, elementId, propertyPath: "background.color", time: t(0), value: "#ffffff" },
				{ trackId, elementId, propertyPath: "background.color", time: t(3), value: "#00ff00" },
			] });
		`,
	},
	{
		name: "text-keyframed-colour-and-position",
		at: 2.5,
		run: `
			const { trackId, elementId } = find("Fading");
			editor.timeline.upsertKeyframes({ keyframes: [
				{ trackId, elementId, propertyPath: "transform.positionX", time: t(0), value: -400 },
				{ trackId, elementId, propertyPath: "transform.positionX", time: t(3), value: 400 },
			] });
		`,
	},
	{
		name: "sticker-flag",
		at: 1,
		run: `
			const { buildStickerElement, resolveStickerIntrinsicSize } = window.__e2e;
			const size = await resolveStickerIntrinsicSize({ stickerId: "flags:KR" });
			editor.timeline.insertElement({ element: { ...buildStickerElement({ stickerId: "flags:KR", name: "Flag", startTime: t(0), intrinsicWidth: size.width, intrinsicHeight: size.height }), params: { ...buildStickerElement({ stickerId: "flags:KR", startTime: t(0) }).params, "transform.positionX": -350, "transform.positionY": -200, "transform.rotate": 15 } }, placement: { mode: "auto" } });
		`,
	},
	{
		name: "sticker-keyframed",
		at: 1.5,
		run: `
			const { trackId, elementId } = find("Flag");
			editor.timeline.upsertKeyframes({ keyframes: [
				{ trackId, elementId, propertyPath: "transform.positionY", time: t(0), value: -250 },
				{ trackId, elementId, propertyPath: "transform.positionY", time: t(3), value: 250 },
				{ trackId, elementId, propertyPath: "transform.scaleX", time: t(0), value: 0.5 },
				{ trackId, elementId, propertyPath: "transform.scaleX", time: t(3), value: 1.5 },
				{ trackId, elementId, propertyPath: "transform.scaleY", time: t(0), value: 0.5 },
				{ trackId, elementId, propertyPath: "transform.scaleY", time: t(3), value: 1.5 },
			] });
		`,
	},
];

module.exports = async (ctx) => {
	fs.mkdirSync(OUT_DIR, { recursive: true });
	await createProject(ctx);
	await importMedia(ctx, ["clipC.mp4"]);
	await ctx.waitFor(`window.__e2e && window.__e2e.editor.media.getAssets().length === 1`, { label: "asset loaded" });
	await ctx.exec(setup);

	const results = [];
	for (const testCase of cases) {
		await ctx.exec(withHelpers(testCase.run));
		await ctx.sleep(300);
		const result = await ctx.exec(`return window.__e2e.compareWithMlt({ seconds: ${testCase.at} })`);
		for (const [engine, dataUrl] of [["editor", result.editorPng], ["mlt", result.mltPng]]) {
			fs.writeFileSync(path.join(OUT_DIR, `stage5-${testCase.name}-${engine}.png`), Buffer.from(dataUrl.split(",")[1], "base64"));
		}
		const summary = {
			name: testCase.name,
			meanDiff: Number(result.meanDiff.toFixed(2)),
			differingPercent: Number((result.differingRatio * 100).toFixed(3)),
			warnings: result.warnings,
		};
		results.push(summary);
		console.log("  " + JSON.stringify(summary));
	}

	for (const result of results) {
		assert(result.warnings.length === 0, `${result.name}: nothing is left unconverted (${result.warnings.join("; ")})`);
		// Anti-aliasing and scaling filters differ slightly between the engines; real layout
		// or colour errors move far more than this.
		assert(result.meanDiff < 3, `${result.name}: pictures match on average (mean diff ${result.meanDiff})`);
		assert(result.differingPercent < 1, `${result.name}: few pixels differ strongly (${result.differingPercent}%)`);
	}
	console.log("console errors:", JSON.stringify(ctx.consoleErrors.slice(0, 5)));
};

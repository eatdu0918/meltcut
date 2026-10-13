// Stage 6: project backgrounds (blurred, gradient, plain) look the same in melt as in the editor.
const fs = require("node:fs");
const path = require("node:path");
const { OUT_DIR, createProject, importMedia, assert } = require("./helpers.cjs");

// clipC is a still test card, so frame timing cannot hide a real difference.
const setup = `
	const { editor, buildElementFromMedia, mediaTimeFromSeconds } = window.__e2e;
	const asset = editor.media.getAssets().find((a) => a.name === "clipC.mp4");
	editor.timeline.insertElement({
		element: { ...buildElementFromMedia({ mediaId: asset.id, mediaType: asset.type, name: asset.name, duration: mediaTimeFromSeconds({ seconds: 6 }), startTime: mediaTimeFromSeconds({ seconds: 0 }) }) },
		placement: { mode: "auto" },
	});
	const main = editor.scenes.getActiveScene().tracks.main;
	editor.timeline.updateElements({ updates: [{ trackId: main.id, elementId: main.elements[0].id, patch: { params: { "transform.scaleX": 0.5, "transform.scaleY": 0.5 } } }] });
	return true;
`;

const settings = (value) => `await window.__e2e.editor.project.updateSettings({ settings: ${JSON.stringify(value)} }); return true;`;

const cases = [
	{ name: "background-blur-default", run: settings({ background: { type: "blur", blurIntensity: 10 } }) },
	{ name: "background-blur-heavy", run: settings({ background: { type: "blur", blurIntensity: 200 } }) },
	// A square canvas makes "cover" crop the 16:9 clip, which a same-shape canvas cannot show.
	{ name: "background-blur-square", run: settings({ canvasSize: { width: 1080, height: 1080 }, background: { type: "blur", blurIntensity: 60 } }) },
	{ name: "background-gradient", run: settings({ background: { type: "color", color: "linear-gradient(135deg, #ff5f6d 0%, #ffc371 100%)" } }) },
	{ name: "background-blur-light", run: settings({ canvasSize: { width: 1280, height: 720 }, background: { type: "blur", blurIntensity: 30 } }) },
	{ name: "background-plain", run: settings({ background: { type: "color", color: "#204080" } }) },
];

module.exports = async (ctx) => {
	fs.mkdirSync(OUT_DIR, { recursive: true });
	await createProject(ctx);
	await importMedia(ctx, ["clipC.mp4"]);
	await ctx.waitFor(`window.__e2e && window.__e2e.editor.media.getAssets().length === 1`, { label: "asset loaded" });
	await ctx.exec(setup);
	// The editor's renderer draws its first blurred backdrop one frame late (the decoded
	// frame is not cached yet), so render once before comparing.
	await ctx.exec(cases[0].run);
	await ctx.exec(`await window.__e2e.compareWithMlt({ seconds: 1 }); return true;`);

	const results = [];
	for (const testCase of cases) {
		await ctx.exec(testCase.run);
		await ctx.sleep(300);
		const result = await ctx.exec(`return window.__e2e.compareWithMlt({ seconds: 1 })`);
		for (const [engine, dataUrl] of [["editor", result.editorPng], ["mlt", result.mltPng]]) {
			fs.writeFileSync(path.join(OUT_DIR, `stage6-${testCase.name}-${engine}.png`), Buffer.from(dataUrl.split(",")[1], "base64"));
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
		assert(result.meanDiff < 3, `${result.name}: pictures match on average (mean diff ${result.meanDiff})`);
		assert(result.differingPercent < 1, `${result.name}: few pixels differ strongly (${result.differingPercent}%)`);
	}
	console.log("console errors:", JSON.stringify(ctx.consoleErrors.slice(0, 5).map((e) => e.slice(0, 200))));
};

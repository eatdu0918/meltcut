// Stage 3: a timeline built in the editor exports through the MLT engine, from the real export panel.
const fs = require("node:fs");
const path = require("node:path");
const { OUT_DIR, TEST_MEDIA_DIR, buildTimeline, clickByText, createProject, importMedia, readStore, assert } = require("./helpers.cjs");
const { probe, frameAt, maxVolumeDb, near } = require("./media-checks.cjs");

const GREY = [191, 191, 191]; // clipB (SMPTE bars) at 100,100
const RED = [254, 24, 0]; // clipA (testsrc2) at 100,100

module.exports = async (ctx) => {
	fs.mkdirSync(OUT_DIR, { recursive: true });
	await createProject(ctx);
	await importMedia(ctx, ["clipA.mp4", "clipB.mp4"]);
	await ctx.waitFor(`window.__e2e && window.__e2e.editor.media.getAssets().length === 2`, { label: "assets loaded in editor" });
	await ctx.exec(buildTimeline);

	// --- Export through the real panel (MP4 / H.264 defaults) ---
	const mp4 = path.join(OUT_DIR, "stage3-panel.mp4");
	fs.rmSync(mp4, { force: true });
	assert(await ctx.exec(clickByText("Export")), "export button clicked");
	await ctx.waitFor(`document.querySelector('[data-testid="mlt-export-panel"]')`, { label: "MLT export panel" });
	await ctx.screenshot(path.join(OUT_DIR, "stage3-panel.png"));
	ctx.queueDialogAnswer(mp4);
	await ctx.exec(`document.querySelector('[data-testid="mlt-export-start"]').click()`);
	const outcome = await ctx.waitFor(
		`document.querySelector('[data-testid="mlt-done"]') ? "done" : document.querySelector('[data-testid="mlt-failed"]')?.innerText`,
		{ timeout: 120_000, label: "panel export to finish" },
	);
	assert(outcome === "done", `panel export succeeded (${outcome})`);
	await ctx.screenshot(path.join(OUT_DIR, "stage3-done.png"));

	const info = probe(mp4);
	assert(info.video.codec_name === "h264" && info.video.width === 1280 && info.video.height === 720, `mp4 video stream (${JSON.stringify(info.video && [info.video.codec_name, info.video.width, info.video.height])})`);
	assert(info.audio?.codec_name === "aac", "mp4 has AAC audio");
	assert(Math.abs(info.duration - 10) < 0.15, `mp4 duration ~10s (${info.duration})`);
	assert(maxVolumeDb(mp4) > -40, "mp4 audio is audible");
	const size = { width: 1280, height: 720 };
	assert(near(frameAt(mp4, 0.5, size).pixel(100, 100), GREY), "0.5s shows the overlay clip");
	assert(near(frameAt(mp4, 2.5, size).pixel(100, 100), RED, 24), "2.5s shows the main clip after the cut");

	// --- Other presets and options, same plumbing without the dialog ---
	const run = (options) => ctx.exec(`return window.__e2e.exportWith(${JSON.stringify(options)})`);
	const cases = [
		{ presetId: "webm-vp9", resolutionId: "480", file: "stage3.webm", check: (i) => i.video.codec_name === "vp9" && i.video.height === 480 && i.video.width === 854 && i.audio?.codec_name === "opus" },
		{ presetId: "mp4-hevc", includeAudio: false, file: "stage3-hevc.mp4", check: (i) => i.video.codec_name === "hevc" && i.audio === null },
		{ presetId: "mov-prores", resolutionId: "480", file: "stage3.mov", check: (i) => i.video.codec_name === "prores" && i.audio?.codec_name === "pcm_s16le" },
		{ presetId: "gif", resolutionId: "480", file: "stage3.gif", check: (i) => i.video.codec_name === "gif" && i.audio === null },
		{ presetId: "mp3", file: "stage3.mp3", check: (i) => i.video === null && i.audio?.codec_name === "mp3" },
		{ presetId: "wav", file: "stage3.wav", check: (i) => i.video === null && i.audio?.codec_name === "pcm_s16le" },
		{ presetId: "mp4-av1", resolutionId: "480", file: "stage3-av1.mp4", check: (i) => i.video.codec_name === "av1" },
	];
	for (const { file, check, ...options } of cases) {
		const outputPath = path.join(OUT_DIR, file);
		fs.rmSync(outputPath, { force: true });
		const result = await run({ ...options, outputPath });
		assert(result.ok, `${options.presetId} export ok (${result.error})`);
		const probed = probe(outputPath);
		assert(check(probed), `${options.presetId} output looks right (${JSON.stringify({ v: probed.video?.codec_name, w: probed.video?.width, h: probed.video?.height, a: probed.audio?.codec_name })})`);
		assert(Math.abs(probed.duration - 10) < 0.3, `${options.presetId} duration ~10s (${probed.duration})`);
		console.log(`  ok ${options.presetId} -> ${file}`);
	}

	// --- Cancelling removes the partial file ---
	const cancelled = path.join(OUT_DIR, "stage3-cancelled.mp4");
	fs.rmSync(cancelled, { force: true });
	const cancelResult = await run({ presetId: "mp4-av1", quality: "very_high", outputPath: cancelled, cancelAfterMs: 800 });
	assert(cancelResult.cancelled === true, `export reports cancelled (${JSON.stringify(cancelResult)})`);
	assert(!fs.existsSync(cancelled), "cancelled export leaves no partial file");

	// --- Non-ASCII paths with spaces, for both the source media and the output ---
	const unicodeDir = path.join(OUT_DIR, "한글 폴더 test");
	fs.mkdirSync(unicodeDir, { recursive: true });
	const unicodeClip = path.join(unicodeDir, "클립 A (복사본).mp4");
	fs.copyFileSync(path.join(TEST_MEDIA_DIR, "clipA.mp4"), unicodeClip);
	await ctx.setInputFiles("input[type=file]", [unicodeClip]);
	await ctx.waitFor(`window.__e2e.editor.media.getAssets().length === 3`, { label: "unicode clip imported" });
	await ctx.exec(`
		const { editor, buildElementFromMedia, mediaTimeFromSeconds } = window.__e2e;
		const asset = editor.media.getAssets().find((a) => a.name.includes("클립"));
		if (asset.filePath !== ${JSON.stringify(unicodeClip)}) throw new Error("unicode path not kept: " + asset.filePath);
		editor.timeline.insertElement({
			element: buildElementFromMedia({ mediaId: asset.id, mediaType: asset.type, name: asset.name, duration: mediaTimeFromSeconds({ seconds: 3 }), startTime: mediaTimeFromSeconds({ seconds: 10 }) }),
			placement: { mode: "auto" },
		});
		return true;
	`);
	const unicodeOut = path.join(unicodeDir, "결과 영상.mp4");
	const unicodeResult = await run({ presetId: "mp4-h264", outputPath: unicodeOut });
	assert(unicodeResult.ok, `export with non-ASCII paths ok (${unicodeResult.error})`);
	const unicodeProbe = probe(unicodeOut);
	assert(Math.abs(unicodeProbe.duration - 13) < 0.3, `non-ASCII export covers the added clip (${unicodeProbe.duration}s)`);
	assert(near(frameAt(unicodeOut, 11, size).pixel(100, 100), RED, 24), "the clip read from a non-ASCII path is in the picture");
	console.log("  ok non-ASCII paths");

	// --- Media whose original file is gone falls back to a cached copy ---
	// The editor copies an import into its own storage in the background; the copy is the
	// fallback, so wait for it before taking the original away.
	const projectId = await ctx.exec(`return location.pathname.split("/").pop()`);
	await ctx.waitFor(
		`(async () => { ${readStore(`video-editor-media-${projectId}`, "media-metadata")} })().then((rows) => rows.length === 3).catch(() => false)`,
		{ label: "imported clip stored" },
	);
	fs.rmSync(unicodeClip);
	const fallbackOut = path.join(OUT_DIR, "stage3-fallback.mp4");
	fs.rmSync(fallbackOut, { force: true });
	const fallbackResult = await run({ presetId: "mp4-h264", outputPath: fallbackOut });
	assert(fallbackResult.ok, `export after the source file was deleted ok (${fallbackResult.error})`);
	assert(near(frameAt(fallbackOut, 11, size).pixel(100, 100), RED, 24), "deleted source still renders from the cache");
	console.log("  ok missing-source fallback");

	// --- An empty timeline is refused with a clear message ---
	await ctx.exec(`
		const { editor } = window.__e2e;
		const tracks = editor.scenes.getActiveScene().tracks;
		const all = [tracks.main, ...tracks.overlay, ...tracks.audio].flatMap((t) => t.elements.map((e) => ({ trackId: t.id, elementId: e.id })));
		editor.timeline.deleteElements({ elements: all });
		return true;
	`);
	const emptyResult = await run({ presetId: "mp4-h264", outputPath: path.join(OUT_DIR, "stage3-empty.mp4") });
	assert(!emptyResult.ok && /Nothing to export/.test(emptyResult.error ?? ""), `empty timeline is refused (${JSON.stringify(emptyResult)})`);
	console.log("  ok empty timeline refused");

	console.log("console errors:", JSON.stringify(ctx.consoleErrors.slice(0, 5)));
};

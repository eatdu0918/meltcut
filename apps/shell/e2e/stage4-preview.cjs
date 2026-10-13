// Stage 4: the MLT preview shows melt-rendered frames for the playhead and plays a rendered clip.
const path = require("node:path");
const { OUT_DIR, buildTimeline, createProject, importMedia, assert } = require("./helpers.cjs");
const { near } = require("./media-checks.cjs");

const GREY = [191, 191, 191]; // clipB at project pixel 100,100
// clipA is red at project pixel 100,100, but a thin rainbow line sweeps across it over time.
// Either way it is strongly red and nothing like clipB's grey.
const showsClipA = ([r, , b]) => r > 200 && b < 80;

/** Colour of the project pixel (100,100) in an <img> or <video>, whatever size it was rendered at. */
const samplePixel = (selector) => `
	const el = document.querySelector(${JSON.stringify(selector)});
	const width = el.naturalWidth || el.videoWidth;
	const height = el.naturalHeight || el.videoHeight;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx2d = canvas.getContext("2d");
	ctx2d.drawImage(el, 0, 0);
	const [r, g, b] = ctx2d.getImageData(Math.round((100 / 1280) * width), Math.round((100 / 720) * height), 1, 1).data;
	return { colour: [r, g, b], width, height };
`;

const frameSrc = `document.querySelector('[data-testid="mlt-preview-frame"]')?.src`;

/** Waits for the overlay to show a frame different from `previousSrc` and be done loading. */
async function nextFrame(ctx, previousSrc) {
	const started = Date.now();
	await ctx.waitFor(
		`(() => { const img = document.querySelector('[data-testid="mlt-preview-frame"]'); const overlay = document.querySelector('[data-testid="mlt-preview-overlay"]'); return img && img.complete && img.naturalWidth > 0 && img.src !== ${JSON.stringify(previousSrc ?? "")} && overlay.dataset.state === "idle"; })()`,
		{ label: "a new MLT preview frame", timeout: 20_000 },
	);
	return { src: await ctx.exec(`return ${frameSrc}`), ms: Date.now() - started };
}

const seek = (seconds) => `
	const { editor, mediaTimeFromSeconds } = window.__e2e;
	editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: ${seconds} }) });
	return true;
`;

module.exports = async (ctx) => {
	await createProject(ctx);
	await importMedia(ctx, ["clipA.mp4", "clipB.mp4"]);
	await ctx.waitFor(`window.__e2e && window.__e2e.editor.media.getAssets().length === 2`, { label: "assets loaded" });
	await ctx.exec(buildTimeline);
	await ctx.exec(seek(0.5));

	assert(await ctx.exec(`return document.querySelector('[data-testid="mlt-preview-overlay"]') === null`), "overlay is off by default");
	await ctx.exec(`document.querySelector('[data-testid="mlt-preview-toggle"]').click()`);

	// Playhead inside the overlay clip.
	let frame = await nextFrame(ctx, null);
	let sample = await ctx.exec(samplePixel('[data-testid="mlt-preview-frame"]'));
	assert(near(sample.colour, GREY), `0.5s frame shows the overlay clip (${sample.colour})`);
	assert(sample.height <= 540, `preview frames are rendered small (${sample.width}x${sample.height})`);
	const timings = [frame.ms];

	// Seeking refreshes the frame.
	await ctx.exec(seek(5));
	frame = await nextFrame(ctx, frame.src);
	sample = await ctx.exec(samplePixel('[data-testid="mlt-preview-frame"]'));
	assert(showsClipA(sample.colour), `5s frame shows the main clip (${sample.colour})`);
	timings.push(frame.ms);
	await ctx.screenshot(path.join(OUT_DIR, "stage4-frame.png"));

	// Editing the timeline refreshes the frame without moving the playhead.
	await ctx.exec(seek(1));
	frame = await nextFrame(ctx, frame.src);
	sample = await ctx.exec(samplePixel('[data-testid="mlt-preview-frame"]'));
	assert(near(sample.colour, GREY), `1s frame shows the overlay clip (${sample.colour})`);
	await ctx.exec(`
		const { editor } = window.__e2e;
		const overlay = editor.scenes.getActiveScene().tracks.overlay.find((t) => t.elements.length);
		editor.timeline.deleteElements({ elements: [{ trackId: overlay.id, elementId: overlay.elements[0].id }] });
		return true;
	`);
	frame = await nextFrame(ctx, frame.src);
	sample = await ctx.exec(samplePixel('[data-testid="mlt-preview-frame"]'));
	assert(showsClipA(sample.colour), `after deleting the overlay clip the frame shows the main clip (${sample.colour})`);
	timings.push(frame.ms);

	// Rapid scrubbing settles on the last position and reports no error.
	for (const seconds of [2, 3, 4, 6, 7, 8]) {
		await ctx.exec(seek(seconds));
		await ctx.sleep(60);
	}
	frame = await nextFrame(ctx, frame.src);
	assert(await ctx.exec(`return document.querySelector('[data-testid="mlt-preview-overlay"]').dataset.state === "idle"`), "scrubbing ends without a preview error");

	// The overlay steps aside during playback.
	await ctx.exec(`window.__e2e.editor.playback.play(); return true;`);
	await ctx.waitFor(`document.querySelector('[data-testid="mlt-preview-overlay"]').classList.contains("hidden")`, { label: "overlay hidden while playing" });
	await ctx.exec(`window.__e2e.editor.playback.pause(); return true;`);

	// A rendered clip plays the MLT result in real time.
	await ctx.exec(`document.querySelector('[data-testid="mlt-preview-clip-button"]').click()`);
	await ctx.waitFor(`(() => { const v = document.querySelector('[data-testid="mlt-preview-clip"]'); return v && v.readyState >= 2; })()`, { label: "preview clip ready", timeout: 60_000 });
	const clip = await ctx.exec(`
		const video = document.querySelector('[data-testid="mlt-preview-clip"]');
		video.pause();
		video.currentTime = 5;
		await new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true }));
		return { duration: video.duration };
	`);
	assert(Math.abs(clip.duration - 10) < 0.3, `preview clip covers the timeline (${clip.duration}s)`);
	sample = await ctx.exec(samplePixel('[data-testid="mlt-preview-clip"]'));
	assert(showsClipA(sample.colour), `preview clip shows the main clip at 5s (${sample.colour})`);
	await ctx.screenshot(path.join(OUT_DIR, "stage4-clip.png"));

	// Editing invalidates the clip, and turning the preview off removes the overlay.
	await ctx.exec(`
		const { editor, mediaTimeFromSeconds } = window.__e2e;
		const main = editor.scenes.getActiveScene().tracks.main;
		editor.timeline.splitElements({ elements: [{ trackId: main.id, elementId: main.elements[0].id }], splitTime: mediaTimeFromSeconds({ seconds: 4 }) });
		return true;
	`);
	await ctx.waitFor(`document.querySelector('[data-testid="mlt-preview-clip"]') === null`, { label: "stale clip removed after an edit" });
	await ctx.exec(`document.querySelector('[data-testid="mlt-preview-toggle"]').click()`);
	await ctx.waitFor(`document.querySelector('[data-testid="mlt-preview-overlay"]') === null`, { label: "overlay removed when turned off" });

	console.log("frame latency ms:", JSON.stringify(timings));
	console.log("console errors:", JSON.stringify(ctx.consoleErrors.slice(0, 5)));
};

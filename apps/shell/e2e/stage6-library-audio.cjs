// Stage 6: audio added from a URL (the sound library) is fetched and ends up in the export.
const fs = require("node:fs");
const path = require("node:path");
const { OUT_DIR, createProject, assert } = require("./helpers.cjs");
const { probe, maxVolumeDb } = require("./media-checks.cjs");

// A two second 440 Hz tone as a WAV, served from a blob URL so the test needs no network.
const addTone = `
	const { editor, buildLibraryAudioElement, mediaTimeFromSeconds } = window.__e2e;
	const rate = 44100, count = rate * 2;
	const wav = new DataView(new ArrayBuffer(44 + count * 2));
	const text = (offset, value) => [...value].forEach((c, i) => wav.setUint8(offset + i, c.charCodeAt(0)));
	text(0, "RIFF"); wav.setUint32(4, 36 + count * 2, true); text(8, "WAVEfmt ");
	wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
	wav.setUint32(24, rate, true); wav.setUint32(28, rate * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true);
	text(36, "data"); wav.setUint32(40, count * 2, true);
	for (let i = 0; i < count; i++) wav.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * 440) * 16000, true);
	const url = URL.createObjectURL(new Blob([wav.buffer], { type: "audio/wav" }));
	for (const [name, sourceUrl, start] of [["Tone", url, 0], ["Gone", "blob:http://127.0.0.1/does-not-exist", 3]]) {
		editor.timeline.insertElement({
			element: buildLibraryAudioElement({ sourceUrl, name, duration: mediaTimeFromSeconds({ seconds: 2 }), startTime: mediaTimeFromSeconds({ seconds: start }) }),
			placement: { mode: "auto" },
		});
	}
	return editor.scenes.getActiveScene().tracks.audio.flatMap((t) => t.elements.map((e) => e.name));
`;

module.exports = async (ctx) => {
	fs.mkdirSync(OUT_DIR, { recursive: true });
	await createProject(ctx);
	await ctx.waitFor(`!!window.__e2e`, { label: "e2e hooks" });
	const names = await ctx.exec(addTone);
	assert(names.includes("Tone") && names.includes("Gone"), `both sounds are on the timeline (${names})`);

	const outputPath = path.join(OUT_DIR, "stage6-library.wav");
	fs.rmSync(outputPath, { force: true });
	const result = await ctx.exec(`return window.__e2e.exportWith({ presetId: "wav", outputPath: ${JSON.stringify(outputPath)} })`);
	assert(result.ok, `export succeeds (${result.error})`);
	console.log("  warnings:", JSON.stringify(result.warnings));
	assert(result.warnings.length === 1 && result.warnings[0].includes("Gone") && result.warnings[0].includes("could not be fetched"), "only the unreachable sound is reported");

	const info = probe(outputPath);
	const volume = maxVolumeDb(outputPath);
	console.log(`  duration ${info.duration}s, max volume ${volume} dB`);
	assert(info.audio, "the file has an audio stream");
	// The tone peaks at 16000 / 32768 = -6.2 dB; a mono source must come out at that level.
	assert(Math.abs(volume + 6.2) < 1, `the tone keeps its level (${volume} dB)`);
	console.log("console errors:", JSON.stringify(ctx.consoleErrors.slice(0, 5).map((e) => e.slice(0, 200))));
};

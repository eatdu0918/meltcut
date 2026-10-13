import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	convertToMlt,
	MLT_TICKS_PER_SECOND,
	type MltConversionInput,
	type MltMediaSource,
} from "../convert";
import { clipTransitionFrames, TRANSITION_PARAMS } from "../transitions";

/** Clip transitions rendered by the real melt. Skips without an MLT install. */

const EXE = process.platform === "win32" ? ".exe" : "";
const workspace = resolve(import.meta.dir, "../../../../../..");
const binDir = [
	process.env.MLT_BIN_DIR,
	join(workspace, "bin/shotcut/Shotcut"),
	join(workspace, "bin/kdenlive/app/kdenlive-26.08.1_standalone/bin"),
].find((dir) => dir && existsSync(join(dir, `melt${EXE}`)));
const melt = binDir ? join(binDir, `melt${EXE}`) : "";
const ffmpeg = binDir ? join(binDir, `ffmpeg${EXE}`) : "";

const CANVAS = { width: 1280, height: 720 };
const seconds = (value: number) => Math.round(value * MLT_TICKS_PER_SECOND);
type Pixel = [number, number, number];
const RED = [255, 0, 0];
const WHITE = [255, 255, 255];

let work = "";
const media = new Map<string, MltMediaSource>();

beforeAll(() => {
	if (!binDir) return;
	work = mkdtempSync(join(tmpdir(), "mlt-transitions-test-"));
	const red = join(work, "red.png");
	execFileSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=1280x720:d=1", "-frames:v", "1", red]);
	media.set("red", { path: red, width: 1280, height: 720 });
	const tone = join(work, "tone.mp4");
	execFileSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=4", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", tone]);
	media.set("tone", { path: tone, width: 320, height: 180 });
});

let counter = 0;
function project({
	mediaId = "red",
	type = "image",
	params = {},
}: {
	mediaId?: string;
	type?: "image" | "video";
	params?: Record<string, unknown>;
}) {
	const element = {
		id: `el${++counter}`,
		type,
		mediaId,
		name: mediaId,
		startTime: 0,
		duration: seconds(3),
		trimStart: 0,
		trimEnd: 0,
		hidden: false,
		isSourceAudioEnabled: true,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
			blendMode: "normal",
			volume: 0,
			muted: false,
			...params,
		},
	};
	const result = convertToMlt({
		projectName: "transitions-test",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: CANVAS,
			background: { type: "color", color: "#ffffff" },
		},
		scene: {
			tracks: {
				main: { id: "main", name: "Main", type: "video", elements: [element], muted: false, hidden: false },
				overlay: [],
				audio: [],
			},
		} as unknown as MltConversionInput["scene"],
		media,
	});
	expect(result.warnings).toEqual([]);
	return result.xml;
}

function frameOf(xml: string, frame: number) {
	const dir = join(work, `render${++counter}`);
	mkdirSync(dir);
	const file = join(dir, "project.mlt");
	const image = join(dir, "frame.png");
	writeFileSync(file, xml);
	const result = spawnSync(melt, [file, `in=${frame}`, `out=${frame}`, "-quiet", "-consumer", `avformat:${image}`, "vcodec=png", "an=1"], { encoding: "utf8" });
	if (result.status !== 0 || !existsSync(image)) {
		throw new Error(`melt failed (${result.status}): ${result.stderr}`);
	}
	const data = execFileSync(ffmpeg, ["-v", "error", "-i", image, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: CANVAS.width * CANVAS.height * 3 + 4096 });
	return (x: number, y: number): Pixel => {
		const i = (Math.round(y) * CANVAS.width + Math.round(x)) * 3;
		return [data[i], data[i + 1], data[i + 2]];
	};
}

function near(actual: Pixel, expected: number[], tolerance = 12) {
	for (let i = 0; i < 3; i++) {
		expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tolerance);
	}
}

describe("transition timing", () => {
	test("each transition is limited to half the clip", () => {
		const at = clipTransitionFrames({
			params: {
				[TRANSITION_PARAMS.inType]: "fade",
				[TRANSITION_PARAMS.inSeconds]: 5,
				[TRANSITION_PARAMS.outType]: "fade",
				[TRANSITION_PARAMS.outSeconds]: 5,
			},
			length: 60,
			framesPerSecond: 30,
		});
		expect(at).not.toBeNull();
		expect(at?.(0).opacity).toBe(0);
		expect(at?.(15).opacity).toBeCloseTo(0.5);
		expect(at?.(30).opacity).toBeGreaterThan(0.9);
		expect(at?.(59).opacity).toBe(0);
	});

	test("a clip without transitions has no modifiers", () => {
		expect(clipTransitionFrames({ params: {}, length: 60, framesPerSecond: 30 })).toBeNull();
		expect(clipTransitionFrames({ params: { [TRANSITION_PARAMS.inType]: "nonsense" }, length: 60, framesPerSecond: 30 })).toBeNull();
	});
});

describe.skipIf(!binDir)("transitions rendered by melt", () => {
	test("fade in and out reveal the background", () => {
		const xml = project({
			params: {
				[TRANSITION_PARAMS.inType]: "fade",
				[TRANSITION_PARAMS.inSeconds]: 1,
				[TRANSITION_PARAMS.outType]: "fade",
				[TRANSITION_PARAMS.outSeconds]: 1,
			},
		});
		near(frameOf(xml, 0)(640, 360), WHITE);
		near(frameOf(xml, 15)(640, 360), [255, 128, 128], 14);
		near(frameOf(xml, 45)(640, 360), RED);
		near(frameOf(xml, 74)(640, 360), [255, 128, 128], 18);
		near(frameOf(xml, 89)(640, 360), WHITE, 14);
	});

	test("slide brings the clip in from the side", () => {
		const xml = project({
			params: { [TRANSITION_PARAMS.inType]: "slide-left", [TRANSITION_PARAMS.inSeconds]: 1 },
		});
		// frame 0: entirely off-screen to the left
		near(frameOf(xml, 0)(100, 360), WHITE);
		// part-way: the left of the frame is covered, the right is not yet
		const middle = frameOf(xml, 6);
		near(middle(60, 360), RED);
		near(middle(1220, 360), WHITE);
		// afterwards: in place
		const done = frameOf(xml, 40);
		near(done(60, 360), RED);
		near(done(1220, 360), RED);
	});

	test("zoom grows the clip from its centre", () => {
		const xml = project({
			params: { [TRANSITION_PARAMS.inType]: "zoom-in", [TRANSITION_PARAMS.inSeconds]: 1 },
		});
		const early = frameOf(xml, 20);
		near(early(640, 360), RED);
		near(early(10, 10), WHITE);
		near(frameOf(xml, 40)(10, 10), RED);
	});

	test("wipe uncovers the clip from one edge", () => {
		const xml = project({
			params: { [TRANSITION_PARAMS.inType]: "wipe-left", [TRANSITION_PARAMS.inSeconds]: 1 },
		});
		// half way through: the left half shows, the right half does not
		const half = frameOf(xml, 15);
		near(half(300, 360), RED);
		near(half(980, 360), WHITE);
		near(frameOf(xml, 45)(980, 360), RED);
	});

	test("a wipe follows a clip that is moved and scaled", () => {
		const xml = project({
			params: {
				"transform.scaleX": 0.5,
				"transform.scaleY": 0.5,
				"transform.positionX": 200,
				[TRANSITION_PARAMS.outType]: "wipe-down",
				[TRANSITION_PARAMS.outSeconds]: 1,
			},
		});
		// The clip is a 640x360 box centred at (840, 360): y 180..540.
		const before = frameOf(xml, 30);
		near(before(840, 200), RED);
		near(before(840, 520), RED);
		// Half way out, a wipe-down keeps only the lower half.
		const half = frameOf(xml, 74);
		near(half(840, 200), WHITE);
		near(half(840, 520), RED);
	});

	test("fade also fades the clip's sound", () => {
		const xml = project({
			mediaId: "tone",
			type: "video",
			params: { [TRANSITION_PARAMS.inType]: "fade", [TRANSITION_PARAMS.inSeconds]: 1 },
		});
		const dir = join(work, `audio${++counter}`);
		mkdirSync(dir);
		writeFileSync(join(dir, "project.mlt"), xml);
		const out = join(dir, "out.wav");
		const render = spawnSync(melt, [join(dir, "project.mlt"), "-quiet", "-consumer", `avformat:${out}`, "vn=1", "acodec=pcm_s16le"], { encoding: "utf8" });
		expect(render.status).toBe(0);
		const level = (start: number) => {
			const detect = spawnSync(ffmpeg, ["-ss", String(start), "-t", "0.2", "-i", out, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
			return Number(/mean_volume: (-?[\d.]+) dB/.exec(detect.stderr)?.[1]);
		};
		const start = level(0.05);
		const full = level(2);
		expect(full - start).toBeGreaterThan(10);
		// A quarter of the way in the gain is about 0.35, roughly -9 dB.
		expect(Math.abs(level(0.25) - (full - 9))).toBeLessThan(5);
	});
});

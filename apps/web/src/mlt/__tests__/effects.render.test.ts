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
	type MltNumberSampler,
} from "../convert";
import { MLT_EFFECTS } from "../effects";

/** Every effect in the MLT catalog, rendered by the real melt. Skips without an MLT install. */

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

let work = "";
const media = new Map<string, MltMediaSource>();

function still({ name, filter }: { name: string; filter: string }) {
	const path = join(work, `${name}.png`);
	execFileSync(ffmpeg, ["-y", "-v", "error", "-f", "lavfi", "-i", filter, "-frames:v", "1", path]);
	media.set(name, { path, width: 1280, height: 720 });
}

beforeAll(() => {
	if (!binDir) return;
	work = mkdtempSync(join(tmpdir(), "mlt-effects-test-"));
	still({ name: "red", filter: "color=c=red:s=1280x720:d=1" });
	still({ name: "grey", filter: "color=c=0x808080:s=1280x720:d=1" });
	// Left half black, right half white.
	still({ name: "edge", filter: "color=c=black:s=1280x720:d=1,drawbox=x=640:y=0:w=640:h=720:color=white:t=fill" });
	// Dark grey next to light grey: room for sharpening to overshoot on both sides.
	still({ name: "softedge", filter: "color=c=0x606060:s=1280x720:d=1,drawbox=x=640:y=0:w=640:h=720:color=0xa0a0a0:t=fill" });
	// A smooth horizontal grey ramp.
	still({ name: "gradient", filter: "gradients=s=1280x720:c0=black:c1=white:x0=0:y0=0:x1=1280:y1=0:d=1" });
});

let counter = 0;
function render({
	mediaId,
	effect,
	params = {},
	background = "#0000ff",
	animations,
	sampleNumber,
	frame = 5,
}: {
	mediaId: string;
	effect?: string;
	params?: Record<string, unknown>;
	background?: string;
	animations?: Record<string, unknown>;
	sampleNumber?: MltNumberSampler;
	frame?: number;
}) {
	const element = {
		id: `el${++counter}`,
		type: "image",
		mediaId,
		name: mediaId,
		startTime: 0,
		duration: seconds(2),
		trimStart: 0,
		trimEnd: 0,
		hidden: false,
		params: {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
			blendMode: "normal",
		},
		effects: effect ? [{ id: "fx", type: effect, enabled: true, params }] : [],
		animations,
	};
	const { xml, warnings } = convertToMlt({
		projectName: "effects-test",
		settings: {
			fps: { numerator: 30, denominator: 1 },
			canvasSize: CANVAS,
			background: { type: "color", color: background },
		},
		scene: {
			tracks: {
				main: { id: "main", name: "Main", type: "video", elements: [element], muted: false, hidden: false },
				overlay: [],
				audio: [],
			},
		} as unknown as MltConversionInput["scene"],
		media,
		sampleNumber,
	});
	expect(warnings).toEqual([]);

	const dir = join(work, `render${counter}`);
	mkdirSync(dir);
	const project = join(dir, "project.mlt");
	const image = join(dir, "frame.png");
	writeFileSync(project, xml);
	const result = spawnSync(melt, [project, `in=${frame}`, `out=${frame}`, "-quiet", "-consumer", `avformat:${image}`, "vcodec=png", "an=1"], { encoding: "utf8" });
	if (result.status !== 0 || !existsSync(image)) {
		throw new Error(`melt failed for ${effect} (${result.status}): ${result.stderr}`);
	}
	const data = execFileSync(ffmpeg, ["-v", "error", "-i", image, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: CANVAS.width * CANVAS.height * 3 + 4096 });
	return (x: number, y: number): Pixel => {
		const i = (Math.round(y) * CANVAS.width + Math.round(x)) * 3;
		return [data[i], data[i + 1], data[i + 2]];
	};
}

function near(actual: Pixel, expected: number[], tolerance = 10) {
	for (let i = 0; i < 3; i++) {
		expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tolerance);
	}
}

const centre = (pixel: (x: number, y: number) => Pixel) => pixel(640, 360);
const spread = (pixel: Pixel) => Math.max(...pixel) - Math.min(...pixel);

describe.skipIf(!binDir)("MLT effect catalog rendered by melt", () => {
	test("every catalog effect renders with its default parameters", () => {
		for (const effect of MLT_EFFECTS) {
			const defaults = Object.fromEntries(effect.params.map((p) => [p.key, p.default]));
			render({ mediaId: "gradient", effect: effect.type, params: defaults });
		}
	}, 120_000);

	test("exposure scales brightness and follows keyframes", () => {
		near(centre(render({ mediaId: "red", effect: "mlt.exposure", params: { level: 50 } })), [128, 0, 0], 14);
		// 0% at the clip start, 100% one second in.
		const sampleNumber: MltNumberSampler = ({ path, localTicks, fallback }) =>
			path === "effects.fx.params.level" ? Math.min(100, (100 * localTicks) / seconds(1)) : fallback;
		const animations = { "effects.fx.params.level": { keys: [{ id: "a" }, { id: "b" }] } };
		near(centre(render({ mediaId: "red", effect: "mlt.exposure", params: { level: 100 }, animations, sampleNumber, frame: 0 })), [0, 0, 0], 14);
		near(centre(render({ mediaId: "red", effect: "mlt.exposure", params: { level: 100 }, animations, sampleNumber, frame: 15 })), [128, 0, 0], 18);
		near(centre(render({ mediaId: "red", effect: "mlt.exposure", params: { level: 100 }, animations, sampleNumber, frame: 45 })), [255, 0, 0], 14);
	});

	test("colour effects move colours the expected way", () => {
		const plain = centre(render({ mediaId: "red" }));
		near(plain, [255, 0, 0]);

		const desaturated = centre(render({ mediaId: "red", effect: "mlt.color", params: { brightness: 0, contrast: 100, saturation: 0, gamma: 100 } }));
		expect(spread(desaturated)).toBeLessThan(12);

		const hue = centre(render({ mediaId: "red", effect: "mlt.hue", params: { degrees: 120 } }));
		expect(hue[0]).toBeLessThan(120);
		expect(Math.max(hue[1], hue[2])).toBeGreaterThan(120);

		const warm = centre(render({ mediaId: "grey", effect: "mlt.temperature", params: { kelvin: 3000 } }));
		expect(warm[0]).toBeGreaterThan(warm[2] + 20);
		const cool = centre(render({ mediaId: "grey", effect: "mlt.temperature", params: { kelvin: 12000 } }));
		expect(cool[2]).toBeGreaterThan(cool[0] + 10);

		expect(spread(centre(render({ mediaId: "red", effect: "mlt.grayscale" })))).toBeLessThan(12);

		const sepia = centre(render({ mediaId: "grey", effect: "mlt.sepia" }));
		expect(sepia[0]).toBeGreaterThan(sepia[2] + 15);

		near(centre(render({ mediaId: "red", effect: "mlt.invert" })), [0, 255, 255], 14);
	});

	test("posterize flattens a gradient into steps", () => {
		const pixel = render({ mediaId: "gradient", effect: "mlt.posterize", params: { levels: 4 } });
		const values = new Set<number>();
		for (let x = 20; x < 1260; x += 10) values.add(pixel(x, 360)[0]);
		expect(values.size).toBeLessThanOrEqual(5);
		expect(values.size).toBeGreaterThanOrEqual(3);
	});

	test("pixelate turns the picture into blocks", () => {
		const distinct = (pixel: (x: number, y: number) => Pixel) => {
			const values = new Set<number>();
			for (let x = 20; x < 1260; x += 4) values.add(pixel(x, 360)[0]);
			return values.size;
		};
		const plain = distinct(render({ mediaId: "gradient" }));
		// 120px at 1080p is 80px here, so about 16 blocks across instead of a smooth ramp.
		const blocks = distinct(render({ mediaId: "gradient", effect: "mlt.pixelate", params: { size: 120 } }));
		expect(plain).toBeGreaterThan(100);
		expect(blocks).toBeLessThan(plain / 3);
	});

	test("vignette darkens the corners and leaves the centre", () => {
		const pixel = render({ mediaId: "grey", effect: "mlt.vignette", params: { radius: 40, feather: 50, strength: 100 } });
		expect(centre(pixel)[0]).toBeGreaterThan(110);
		expect(pixel(10, 10)[0]).toBeLessThan(60);
	});

	test("mirror and flip move the picture", () => {
		const mirrored = render({ mediaId: "edge", effect: "mlt.mirror", params: { mode: "horizontal" } });
		near(mirrored(200, 360), mirrored(1080, 360), 6);

		const flipped = render({ mediaId: "edge", effect: "mlt.flip", params: { horizontal: true, vertical: false } });
		near(flipped(200, 360), [255, 255, 255]);
		near(flipped(1080, 360), [0, 0, 0]);
	});

	test("crop reveals the background around the kept area", () => {
		const pixel = render({ mediaId: "red", effect: "mlt.crop", params: { left: 25, right: 25, top: 10, bottom: 10, radius: 0 } });
		near(centre(pixel), [255, 0, 0]);
		near(pixel(160, 360), [0, 0, 255]); // inside the cropped-off left quarter
		near(pixel(1120, 360), [0, 0, 255]);
		near(pixel(640, 30), [0, 0, 255]);
		near(pixel(400, 360), [255, 0, 0]);
	});

	test("chroma key removes the key colour", () => {
		near(centre(render({ mediaId: "red", effect: "mlt.chromakey", params: { color: "#ff0000", tolerance: 20 } })), [0, 0, 255], 14);
		// A colour far from the key stays.
		near(centre(render({ mediaId: "grey", effect: "mlt.chromakey", params: { color: "#ff0000", tolerance: 10 } })), [128, 128, 128], 14);
	});

	test("sharpen exaggerates an edge and leaves flat areas alone", () => {
		const pixel = render({ mediaId: "softedge", effect: "mlt.sharpen", params: { amount: 300 } });
		expect(pixel(638, 360)[0]).toBeLessThan(90); // darker than the 96 it started as
		expect(pixel(641, 360)[0]).toBeGreaterThan(166); // lighter than the 160 it started as
		near(pixel(200, 360), [96, 96, 96], 4);
		near(pixel(1080, 360), [160, 160, 160], 4);
	});

	test("grain, glow and old film change the picture without breaking it", () => {
		const plain = render({ mediaId: "gradient" });
		for (const [effect, params] of [
			["mlt.grain", { amount: 60 }],
			["mlt.glow", { amount: 80 }],
			["mlt.oldfilm", {}],
		] as const) {
			const pixel = render({ mediaId: "gradient", effect, params });
			let difference = 0;
			for (let x = 40; x < 1240; x += 40) {
				for (let y = 40; y < 700; y += 40) {
					difference += Math.abs(pixel(x, y)[0] - plain(x, y)[0]) + Math.abs(pixel(x, y)[2] - plain(x, y)[2]);
				}
			}
			expect(difference).toBeGreaterThan(40);
		}
	}, 60_000);
});

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

/**
 * Renders converted projects with the real melt and checks pixels. These tests are the
 * ground truth for the converter; they skip when no MLT install is around.
 */

const EXE = process.platform === "win32" ? ".exe" : "";
const workspace = resolve(import.meta.dir, "../../../../../..");
const binDir = [
	process.env.MLT_BIN_DIR,
	join(workspace, "bin/shotcut/Shotcut"),
	join(workspace, "bin/kdenlive/app/kdenlive-26.08.1_standalone/bin"),
].find((dir) => dir && existsSync(join(dir, `melt${EXE}`)));

const melt = binDir ? join(binDir, `melt${EXE}`) : "";
const ffmpeg = binDir ? join(binDir, `ffmpeg${EXE}`) : "";

const FPS = 30;
const CANVAS = { width: 1280, height: 720 };
const seconds = (value: number) => Math.round(value * MLT_TICKS_PER_SECOND);
const frames = (value: number) => Math.round((value * MLT_TICKS_PER_SECOND) / FPS);

let work = "";
const media = new Map<string, MltMediaSource>();

/** Generates a tiny test clip with ffmpeg's lavfi sources. */
function generate({
	name,
	extension,
	args,
	width,
	height,
}: {
	name: string;
	extension: string;
	args: string[];
	width: number;
	height: number;
}) {
	const path = join(work, `${name}.${extension}`);
	execFileSync(ffmpeg, ["-y", "-v", "error", ...args, path]);
	media.set(name, { path, width, height });
}

beforeAll(() => {
	if (!binDir) return;
	work = mkdtempSync(join(tmpdir(), "mlt-render-test-"));
	// Grey level encodes the frame number: Y = 16 + N, so RGB grey = N * 255 / 219.
	generate({
		name: "ramp",
		extension: "mp4",
		width: 320,
		height: 180,
		args: ["-f", "lavfi", "-i", "nullsrc=s=320x180:r=30:d=6,geq=lum='16+N':cb=128:cr=128", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-f", "mp4"],
	});
	generate({
		name: "red",
		extension: "mp4",
		width: 320,
		height: 180,
		args: ["-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=4", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-f", "mp4"],
	});
	// Left half black, right half white: a sharp edge to measure blur on.
	generate({
		name: "edge",
		extension: "png",
		width: 320,
		height: 180,
		args: ["-f", "lavfi", "-i", "color=c=black:s=320x180:d=1,drawbox=x=160:y=0:w=160:h=180:color=white:t=fill", "-frames:v", "1", "-f", "image2", "-c:v", "png"],
	});
});

type Element = Record<string, unknown>;

const BASE_PARAMS = {
	"transform.positionX": 0,
	"transform.positionY": 0,
	"transform.scaleX": 1,
	"transform.scaleY": 1,
	"transform.rotate": 0,
	opacity: 1,
	blendMode: "normal",
	volume: 0,
	muted: false,
};

let elementCounter = 0;
function clip({
	mediaId,
	type = "video",
	start = 0,
	duration,
	trimStart = 0,
	params = {},
	...rest
}: {
	mediaId: string;
	type?: "video" | "image";
	start?: number;
	duration: number;
	trimStart?: number;
	params?: Record<string, unknown>;
} & Element): Element {
	return {
		id: `el${++elementCounter}`,
		type,
		mediaId,
		name: mediaId,
		startTime: seconds(start),
		duration: seconds(duration),
		trimStart: seconds(trimStart),
		trimEnd: 0,
		isSourceAudioEnabled: true,
		hidden: false,
		params: { ...BASE_PARAMS, ...params },
		...rest,
	};
}

function scene({ main, overlay = [] }: { main: Element[]; overlay?: Element[][] }) {
	return {
		tracks: {
			main: { id: "main", name: "Main", type: "video", elements: main, muted: false, hidden: false },
			overlay: overlay.map((elements, index) => ({
				id: `overlay${index}`,
				name: `Overlay ${index}`,
				type: "video",
				elements,
				muted: false,
				hidden: false,
			})),
			audio: [],
		},
	} as unknown as MltConversionInput["scene"];
}

function convert({
	background = "#000000",
	...rest
}: {
	scene: MltConversionInput["scene"];
	background?: string;
	outputSize?: { width: number; height: number };
	sampleNumber?: MltNumberSampler;
}) {
	return convertToMlt({
		projectName: "render-test",
		settings: {
			fps: { numerator: FPS, denominator: 1 },
			canvasSize: CANVAS,
			background: { type: "color", color: background },
		},
		media,
		...rest,
	});
}

let renderCounter = 0;
/** Renders one frame and returns a pixel reader in output coordinates. */
function renderFrame({
	xml,
	frame,
	size = CANVAS,
}: {
	xml: string;
	frame: number;
	size?: { width: number; height: number };
}) {
	const dir = join(work, `render${++renderCounter}`);
	mkdirSync(dir);
	const project = join(dir, "project.mlt");
	const image = join(dir, "frame.png");
	writeFileSync(project, xml);
	const result = spawnSync(melt, [project, `in=${frame}`, `out=${frame}`, "-quiet", "-consumer", `avformat:${image}`, "vcodec=png", "an=1"], { encoding: "utf8" });
	if (result.status !== 0 || !existsSync(image)) {
		throw new Error(`melt failed (${result.status}): ${result.stderr}`);
	}
	const data = execFileSync(ffmpeg, ["-v", "error", "-i", image, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: size.width * size.height * 3 + 4096 });
	expect(data.length).toBe(size.width * size.height * 3);
	return (x: number, y: number): [number, number, number] => {
		const i = (Math.round(y) * size.width + Math.round(x)) * 3;
		return [data[i], data[i + 1], data[i + 2]];
	};
}

/** Source frame number shown by the "ramp" clip at a pixel. */
const rampFrame = (pixel: [number, number, number]) => (pixel[1] * 219) / 255;

function expectNear(actual: number[], expected: number[], tolerance = 6) {
	for (let i = 0; i < expected.length; i++) {
		expect(Math.abs(actual[i] - expected[i])).toBeLessThanOrEqual(tolerance);
	}
}

const RED = [255, 0, 0];

describe.skipIf(!binDir)("converter output rendered by melt", () => {
	test("trim and timeline position pick the right source frame", () => {
		const { xml } = convert({
			scene: scene({
				main: [clip({ mediaId: "ramp", start: 1, duration: 3, trimStart: 1 })],
			}),
		});
		// timeline frame 40 = clip frame 10 = source frame 40
		expect(Math.abs(rampFrame(renderFrame({ xml, frame: 40 })(640, 360)) - 40)).toBeLessThanOrEqual(1.5);
		// before the clip starts there is only background
		expectNear(renderFrame({ xml, frame: 10 })(640, 360), [0, 0, 0]);
	});

	test("speed change plays the source faster and slower", () => {
		const fast = convert({
			scene: scene({
				main: [clip({ mediaId: "ramp", duration: 2, trimStart: 1, retime: { rate: 2 } })],
			}),
		});
		// clip frame 20 at 2x from a 1s trim = source frame 30 + 40
		expect(Math.abs(rampFrame(renderFrame({ xml: fast.xml, frame: 20 })(640, 360)) - 70)).toBeLessThanOrEqual(2.5);
		expect(fast.warnings).toEqual([]);

		const slow = convert({
			scene: scene({
				main: [clip({ mediaId: "ramp", duration: 4, retime: { rate: 0.5 } })],
			}),
		});
		// clip frame 60 at 0.5x = source frame 30
		expect(Math.abs(rampFrame(renderFrame({ xml: slow.xml, frame: 60 })(640, 360)) - 30)).toBeLessThanOrEqual(2.5);
	});

	test("position and scale place the clip like the editor does", () => {
		const { xml, warnings } = convert({
			background: "#0000ff",
			scene: scene({
				main: [
					clip({
						mediaId: "red",
						duration: 2,
						params: {
							"transform.positionX": 200,
							"transform.positionY": -100,
							"transform.scaleX": 0.5,
							"transform.scaleY": 0.5,
						},
					}),
				],
			}),
		});
		expect(warnings).toEqual([]);
		const pixel = renderFrame({ xml, frame: 10 });
		// 640x360 box centred at (840, 260): spans x 520..1160, y 80..440
		expectNear(pixel(840, 260), RED);
		expectNear(pixel(530, 90), RED);
		expectNear(pixel(1150, 430), RED);
		expectNear(pixel(500, 260), [0, 0, 255]);
		expectNear(pixel(840, 460), [0, 0, 255]);
		expectNear(pixel(1180, 260), [0, 0, 255]);
	});

	test("rotation turns the clip around its centre", () => {
		const { xml } = convert({
			background: "#0000ff",
			scene: scene({
				main: [
					clip({
						mediaId: "red",
						duration: 2,
						params: { "transform.scaleX": 0.5, "transform.scaleY": 0.5, "transform.rotate": 90 },
					}),
				],
			}),
		});
		const pixel = renderFrame({ xml, frame: 10 });
		// a 640x360 box rotated 90 degrees covers x 460..820, y 40..680
		expectNear(pixel(640, 60), RED);
		expectNear(pixel(640, 660), RED);
		expectNear(pixel(360, 360), [0, 0, 255]);
		expectNear(pixel(920, 360), [0, 0, 255]);
	});

	test("opacity mixes with what is underneath", () => {
		const { xml } = convert({
			background: "#ffffff",
			scene: scene({
				main: [clip({ mediaId: "red", duration: 2, params: { opacity: 0.5 } })],
			}),
		});
		expectNear(renderFrame({ xml, frame: 10 })(640, 360), [255, 128, 128], 8);
	});

	test("keyframes are timed from the clip start, even on a trimmed clip", () => {
		// Opacity ramps 0 -> 1 over the clip's first second.
		const sampleNumber: MltNumberSampler = ({ path, localTicks, fallback }) =>
			path === "opacity" ? Math.min(1, localTicks / seconds(1)) : fallback;
		const { xml, warnings } = convert({
			background: "#ffffff",
			sampleNumber,
			scene: scene({
				main: [
					clip({
						mediaId: "red",
						start: 1,
						duration: 2,
						trimStart: 1,
						animations: { opacity: { keys: [{ id: "a" }, { id: "b" }] } },
					}),
				],
			}),
		});
		expect(warnings).toEqual([]);
		// timeline frame 30 = clip frame 0: fully transparent, white shows
		expectNear(renderFrame({ xml, frame: 30 })(640, 360), [255, 255, 255], 8);
		// clip frame 15: half way
		expectNear(renderFrame({ xml, frame: 45 })(640, 360), [255, 128, 128], 10);
		// clip frame 45: holds at fully opaque
		expectNear(renderFrame({ xml, frame: 75 })(640, 360), RED, 8);
	});

	test("animated position moves the clip frame by frame", () => {
		// Slides 400 project pixels to the right over two seconds.
		const sampleNumber: MltNumberSampler = ({ path, localTicks, fallback }) =>
			path === "transform.positionX" ? (400 * localTicks) / seconds(2) : fallback;
		const { xml } = convert({
			background: "#0000ff",
			sampleNumber,
			scene: scene({
				main: [
					clip({
						mediaId: "red",
						duration: 2,
						params: { "transform.scaleX": 0.25, "transform.scaleY": 0.25 },
						animations: { "transform.positionX": { keys: [{ id: "a" }, { id: "b" }] } },
					}),
				],
			}),
		});
		// 320-wide box: centred at 640 on frame 0, at 840 on frame 30
		const first = renderFrame({ xml, frame: 0 });
		expectNear(first(640, 360), RED);
		expectNear(first(840, 360), [0, 0, 255]);
		const later = renderFrame({ xml, frame: 30 });
		expectNear(later(840, 360), RED);
		expectNear(later(640, 360), [0, 0, 255]);
	});

	test("blend modes composite against the track below", () => {
		const { xml, warnings } = convert({
			background: "#808080",
			scene: scene({
				main: [clip({ mediaId: "red", duration: 2, params: { blendMode: "multiply" } })],
			}),
		});
		expect(warnings).toEqual([]);
		expectNear(renderFrame({ xml, frame: 10 })(640, 360), [128, 0, 0], 8);
	});

	test("one track with mixed blend modes keeps each clip's own mode", () => {
		const { xml } = convert({
			background: "#808080",
			scene: scene({
				main: [
					clip({ mediaId: "red", duration: 1 }),
					clip({ mediaId: "red", start: 1, duration: 1, params: { blendMode: "screen" } }),
				],
			}),
		});
		expectNear(renderFrame({ xml, frame: 10 })(640, 360), RED, 8);
		// screen(red, grey) = 255 - (255-255)(255-128)/255, 255 - (255)(127)/255 ...
		expectNear(renderFrame({ xml, frame: 40 })(640, 360), [255, 128, 128], 8);
	});

	test("blur softens an edge by roughly the editor's sigma", () => {
		const plain = convert({
			scene: scene({ main: [clip({ mediaId: "edge", type: "image", duration: 1 })] }),
		});
		const sharp = renderFrame({ xml: plain.xml, frame: 5 });
		expectNear(sharp(600, 360), [0, 0, 0]);
		expectNear(sharp(680, 360), [255, 255, 255]);

		const blurred = convert({
			scene: scene({
				main: [
					clip({
						mediaId: "edge",
						type: "image",
						duration: 1,
						effects: [{ id: "fx", type: "blur", enabled: true, params: { intensity: 60 } }],
					}),
				],
			}),
		});
		expect(blurred.warnings).toEqual([]);
		// intensity 60 -> sigma 12 * (1280 / 1920) = 8 px
		const soft = renderFrame({ xml: blurred.xml, frame: 5 });
		const at = (x: number) => soft(x, 360)[0];
		expect(at(640)).toBeGreaterThan(90);
		expect(at(640)).toBeLessThan(165);
		// one sigma either side of the edge: ~16% and ~84% of white
		expect(at(632)).toBeGreaterThan(15);
		expect(at(632)).toBeLessThan(80);
		expect(at(648)).toBeGreaterThan(175);
		expect(at(648)).toBeLessThan(240);
		// far from the edge nothing changes
		expect(at(560)).toBeLessThan(8);
		expect(at(720)).toBeGreaterThan(247);
	});

	test("rendering at another size keeps the layout", () => {
		const size = { width: 640, height: 360 };
		const { xml } = convert({
			background: "#0000ff",
			outputSize: size,
			scene: scene({
				main: [
					clip({
						mediaId: "red",
						duration: 2,
						params: {
							"transform.positionX": 200,
							"transform.positionY": -100,
							"transform.scaleX": 0.5,
							"transform.scaleY": 0.5,
						},
					}),
				],
			}),
		});
		const pixel = renderFrame({ xml, frame: 10, size });
		// half of the full-size layout: box spans x 260..580, y 40..220
		expectNear(pixel(420, 130), RED);
		expectNear(pixel(250, 130), [0, 0, 255]);
		expectNear(pixel(420, 230), [0, 0, 255]);
	});

	test("volume in dB changes the level of the rendered audio", () => {
		const level = (volume: number) => {
			const { xml } = convert({
				scene: scene({ main: [clip({ mediaId: "ramp", duration: 2, params: { volume } })] }),
			});
			const dir = join(work, `audio${++renderCounter}`);
			mkdirSync(dir);
			writeFileSync(join(dir, "project.mlt"), xml);
			const out = join(dir, "out.wav");
			const render = spawnSync(melt, [join(dir, "project.mlt"), "-quiet", "-consumer", `avformat:${out}`, "vn=1", "acodec=pcm_s16le"], { encoding: "utf8" });
			expect(render.status).toBe(0);
			const detect = spawnSync(ffmpeg, ["-i", out, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
			return Number(/mean_volume: (-?[\d.]+) dB/.exec(detect.stderr)?.[1]);
		};
		const reference = level(0);
		expect(Math.abs(level(-12) - (reference - 12))).toBeLessThan(1);
	});
});

// `frames` documents the tick maths used above; keep it referenced for readers.
void frames;

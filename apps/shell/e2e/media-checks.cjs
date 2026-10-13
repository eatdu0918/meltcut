// Inspects rendered files with the ffmpeg/ffprobe that ship next to melt.
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");
const { findMltBinDir, EXE } = require("../src/mlt.cjs");

const tool = (name) => {
	const binDir = findMltBinDir();
	if (!binDir) throw new Error("MLT bin folder not found; cannot verify renders");
	return path.join(binDir, `${name}${EXE}`);
};

function probe(file) {
	const info = JSON.parse(
		execFileSync(tool("ffprobe"), ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { encoding: "utf8" }),
	);
	return {
		duration: Number(info.format.duration),
		format: info.format.format_name,
		video: info.streams.find((s) => s.codec_type === "video") ?? null,
		audio: info.streams.find((s) => s.codec_type === "audio") ?? null,
	};
}

/** Decodes one frame as raw RGB. */
function frameAt(file, seconds, { width, height }) {
	const data = execFileSync(
		tool("ffmpeg"),
		["-v", "error", "-ss", String(seconds), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
		{ maxBuffer: width * height * 3 + 4096 },
	);
	return {
		pixel: (x, y) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)],
		/** Counts near-white pixels inside a box given as fractions of the frame. */
		whiteIn: (x0, y0, x1, y1) => {
			let count = 0;
			for (let y = Math.floor(height * y0); y < height * y1; y++) {
				for (let x = Math.floor(width * x0); x < width * x1; x++) {
					const i = (y * width + x) * 3;
					if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) count++;
				}
			}
			return count;
		},
	};
}

function maxVolumeDb(file) {
	const result = spawnSync(tool("ffmpeg"), ["-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
	return Number(/max_volume: (-?[\d.]+) dB/.exec(result.stderr)?.[1]);
}

const near = (actual, expected, tolerance = 14) =>
	actual.every((channel, i) => Math.abs(channel - expected[i]) <= tolerance);

module.exports = { probe, frameAt, maxVolumeDb, near };

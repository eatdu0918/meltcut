/**
 * Export presets for the MLT engine. Each one is a set of properties for melt's
 * `avformat` consumer, which are FFmpeg option names.
 */
export type MltQuality = "low" | "medium" | "high" | "very_high";

export interface MltExportPreset {
	id: string;
	label: string;
	description: string;
	extension: string;
	hasVideo: boolean;
	hasAudio: boolean;
	properties: (args: { quality: MltQuality }) => Record<string, string | number>;
}

// Constant-quality factors: lower is better. x264/x265 use 0-51, VP9/AV1 use 0-63.
const CRF_X264: Record<MltQuality, number> = { low: 28, medium: 23, high: 18, very_high: 14 };
const CRF_X265: Record<MltQuality, number> = { low: 30, medium: 26, high: 21, very_high: 17 };
const CRF_VP9: Record<MltQuality, number> = { low: 40, medium: 33, high: 28, very_high: 20 };
const CRF_AV1: Record<MltQuality, number> = { low: 42, medium: 35, high: 28, very_high: 22 };
const AUDIO_BITRATE: Record<MltQuality, string> = { low: "128k", medium: "160k", high: "192k", very_high: "256k" };

export const MLT_EXPORT_PRESETS: MltExportPreset[] = [
	{
		id: "mp4-h264",
		label: "MP4 (H.264)",
		description: "Plays everywhere",
		extension: ".mp4",
		hasVideo: true,
		hasAudio: true,
		properties: ({ quality }) => ({
			f: "mp4",
			vcodec: "libx264",
			crf: CRF_X264[quality],
			preset: "medium",
			pix_fmt: "yuv420p",
			acodec: "aac",
			ab: AUDIO_BITRATE[quality],
			movflags: "+faststart",
		}),
	},
	{
		id: "mp4-hevc",
		label: "MP4 (HEVC / H.265)",
		description: "Smaller files, slower to encode",
		extension: ".mp4",
		hasVideo: true,
		hasAudio: true,
		properties: ({ quality }) => ({
			f: "mp4",
			vcodec: "libx265",
			crf: CRF_X265[quality],
			preset: "medium",
			pix_fmt: "yuv420p",
			vtag: "hvc1",
			acodec: "aac",
			ab: AUDIO_BITRATE[quality],
			movflags: "+faststart",
		}),
	},
	{
		id: "webm-vp9",
		label: "WebM (VP9)",
		description: "Open format for the web",
		extension: ".webm",
		hasVideo: true,
		hasAudio: true,
		properties: ({ quality }) => ({
			f: "webm",
			vcodec: "libvpx-vp9",
			crf: CRF_VP9[quality],
			vb: 0,
			pix_fmt: "yuv420p",
			acodec: "libopus",
			ab: AUDIO_BITRATE[quality],
		}),
	},
	{
		id: "mp4-av1",
		label: "MP4 (AV1)",
		description: "Smallest files, slowest to encode",
		extension: ".mp4",
		hasVideo: true,
		hasAudio: true,
		properties: ({ quality }) => ({
			f: "mp4",
			vcodec: "libsvtav1",
			crf: CRF_AV1[quality],
			pix_fmt: "yuv420p",
			acodec: "aac",
			ab: AUDIO_BITRATE[quality],
			movflags: "+faststart",
		}),
	},
	{
		id: "mov-prores",
		label: "MOV (ProRes 422 HQ)",
		description: "Editing master, very large files",
		extension: ".mov",
		hasVideo: true,
		hasAudio: true,
		properties: () => ({
			f: "mov",
			vcodec: "prores_ks",
			vprofile: 3,
			pix_fmt: "yuv422p10le",
			acodec: "pcm_s16le",
		}),
	},
	{
		id: "gif",
		label: "GIF",
		description: "Animated image, no sound",
		extension: ".gif",
		hasVideo: true,
		hasAudio: false,
		properties: () => ({ f: "gif", an: 1 }),
	},
	{
		id: "mp3",
		label: "MP3 (audio only)",
		description: "Sound without picture",
		extension: ".mp3",
		hasVideo: false,
		hasAudio: true,
		properties: ({ quality }) => ({
			f: "mp3",
			vn: 1,
			acodec: "libmp3lame",
			ab: AUDIO_BITRATE[quality],
		}),
	},
	{
		id: "wav",
		label: "WAV (audio only)",
		description: "Uncompressed sound",
		extension: ".wav",
		hasVideo: false,
		hasAudio: true,
		properties: () => ({ f: "wav", vn: 1, acodec: "pcm_s16le" }),
	},
];

export const MLT_RESOLUTIONS = [
	{ id: "project", label: "Same as project", height: null },
	{ id: "2160", label: "2160p (4K)", height: 2160 },
	{ id: "1080", label: "1080p", height: 1080 },
	{ id: "720", label: "720p", height: 720 },
	{ id: "480", label: "480p", height: 480 },
] as const;

export type MltResolutionId = (typeof MLT_RESOLUTIONS)[number]["id"];

/** Output size for a target height, keeping the project's aspect ratio and even dimensions. */
export function resolveOutputSize({
	canvasSize,
	resolutionId,
}: {
	canvasSize: { width: number; height: number };
	resolutionId: MltResolutionId;
}): { width: number; height: number } {
	const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
	const target = MLT_RESOLUTIONS.find((r) => r.id === resolutionId)?.height;
	if (!target) return { width: even(canvasSize.width), height: even(canvasSize.height) };
	return {
		width: even((canvasSize.width * target) / canvasSize.height),
		height: even(target),
	};
}

export function buildConsumerProperties({
	preset,
	quality,
	includeAudio,
}: {
	preset: MltExportPreset;
	quality: MltQuality;
	includeAudio: boolean;
}): Record<string, string | number> {
	// Output size is not a consumer property: see `outputSize` in convertToMlt.
	const properties = { ...preset.properties({ quality }) };
	if (preset.hasAudio && !includeAudio && preset.hasVideo) {
		properties.an = 1;
		delete properties.acodec;
		delete properties.ab;
	}
	return properties;
}

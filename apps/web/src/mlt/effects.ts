import type { ParamDefinition, ParamValue } from "@/params";

/**
 * Effects that exist only in the MLT engine. They are registered next to the editor's
 * own effects, so they appear in the Effects panel and get the same parameter controls.
 *
 * The editor's real-time preview has no shader for them and shows the clip unchanged;
 * the MLT preview and the MLT export render them.
 */
export const MLT_EFFECT_PREFIX = "mlt.";

export interface MltFilterSpec {
	service: string;
	props: Record<string, string | number>;
}

/** Reads the parameters of one effect instance while its filters are being built. */
export interface MltEffectReader {
	/** Raw stored value. */
	raw: (key: string) => ParamValue | undefined;
	/**
	 * A number as MLT text: a plain value, or an animation string when the parameter is
	 * keyframed. `map` converts from the editor's unit to the filter's.
	 */
	number: (key: string, map?: (value: number) => number) => string;
	/** Several numbers combined into one property value; never animated. */
	combine: (format: (get: (key: string) => number) => string) => string;
}

export interface MltEffectContext {
	/** Size of the frame the filter runs on, in output pixels. */
	width: number;
	height: number;
}

export interface MltEffectDefinition {
	type: string;
	name: string;
	keywords: string[];
	params: ParamDefinition[];
	filters: (read: MltEffectReader, context: MltEffectContext) => MltFilterSpec[];
}

const percent = (value: number) => value / 100;

const slider = ({
	key,
	label,
	min,
	max,
	step = 1,
	defaultValue,
	keyframable = false,
}: {
	key: string;
	label: string;
	min: number;
	max: number;
	step?: number;
	defaultValue: number;
	keyframable?: boolean;
}): ParamDefinition => ({
	key,
	label,
	type: "number",
	default: defaultValue,
	min,
	max,
	step,
	keyframable,
});

export const MLT_EFFECTS: MltEffectDefinition[] = [
	{
		type: "mlt.exposure",
		name: "Exposure",
		keywords: ["exposure", "brightness", "light", "dark", "flash", "fade"],
		params: [
			slider({ key: "level", label: "Level", min: 0, max: 300, defaultValue: 100, keyframable: true }),
		],
		filters: (read) => [
			{ service: "brightness", props: { level: read.number("level", percent) } },
		],
	},
	{
		type: "mlt.color",
		name: "Color adjust",
		keywords: ["color", "contrast", "saturation", "gamma", "brightness", "grade"],
		params: [
			slider({ key: "brightness", label: "Brightness", min: -100, max: 100, defaultValue: 0 }),
			slider({ key: "contrast", label: "Contrast", min: 0, max: 200, defaultValue: 100 }),
			slider({ key: "saturation", label: "Saturation", min: 0, max: 300, defaultValue: 100 }),
			slider({ key: "gamma", label: "Gamma", min: 10, max: 300, defaultValue: 100 }),
		],
		filters: (read) => [
			{
				service: "avfilter.eq",
				props: {
					"av.brightness": read.number("brightness", percent),
					"av.contrast": read.number("contrast", percent),
					"av.saturation": read.number("saturation", percent),
					"av.gamma": read.number("gamma", percent),
				},
			},
		],
	},
	{
		type: "mlt.hue",
		name: "Hue shift",
		keywords: ["hue", "color", "tint", "rotate"],
		params: [
			slider({ key: "degrees", label: "Degrees", min: -180, max: 180, defaultValue: 90 }),
		],
		filters: (read) => [
			{ service: "avfilter.hue", props: { "av.h": read.number("degrees") } },
		],
	},
	{
		type: "mlt.temperature",
		name: "Color temperature",
		keywords: ["temperature", "warm", "cool", "white balance", "kelvin"],
		params: [
			slider({ key: "kelvin", label: "Kelvin", min: 2000, max: 12000, step: 100, defaultValue: 4500 }),
		],
		filters: (read) => [
			{
				service: "avfilter.colortemperature",
				props: { "av.temperature": read.number("kelvin") },
			},
		],
	},
	{
		type: "mlt.grayscale",
		name: "Black & white",
		keywords: ["grayscale", "greyscale", "black", "white", "mono"],
		params: [],
		filters: () => [{ service: "greyscale", props: {} }],
	},
	{
		type: "mlt.sepia",
		name: "Sepia",
		keywords: ["sepia", "vintage", "brown", "old"],
		params: [],
		filters: () => [{ service: "sepia", props: { u: 75, v: 150 } }],
	},
	{
		type: "mlt.invert",
		name: "Invert",
		keywords: ["invert", "negative"],
		params: [],
		filters: () => [{ service: "invert", props: {} }],
	},
	{
		type: "mlt.sharpen",
		name: "Sharpen",
		keywords: ["sharpen", "detail", "crisp", "unsharp"],
		params: [
			slider({ key: "amount", label: "Amount", min: 0, max: 500, defaultValue: 150 }),
		],
		filters: (read) => [
			{
				service: "avfilter.unsharp",
				props: {
					"av.luma_amount": read.number("amount", percent),
					"av.luma_msize_x": 5,
					"av.luma_msize_y": 5,
				},
			},
		],
	},
	{
		type: "mlt.vignette",
		name: "Vignette",
		keywords: ["vignette", "dark", "edges", "focus"],
		params: [
			slider({ key: "radius", label: "Radius", min: 0, max: 100, defaultValue: 50, keyframable: true }),
			slider({ key: "feather", label: "Feather", min: 0, max: 100, defaultValue: 80 }),
			slider({ key: "strength", label: "Strength", min: 0, max: 100, defaultValue: 100 }),
		],
		filters: (read) => [
			{
				service: "vignette",
				props: {
					radius: read.number("radius", percent),
					smooth: read.number("feather", percent),
					// The filter's `opacity` is how much picture is left at the edge.
					opacity: read.number("strength", (value) => 1 - value / 100),
				},
			},
		],
	},
	{
		type: "mlt.glow",
		name: "Glow",
		keywords: ["glow", "bloom", "soft", "dream"],
		params: [
			slider({ key: "amount", label: "Amount", min: 0, max: 100, defaultValue: 50, keyframable: true }),
		],
		filters: (read) => [
			{ service: "frei0r.glow", props: { "0": read.number("amount", percent) } },
		],
	},
	{
		type: "mlt.pixelate",
		name: "Pixelate",
		keywords: ["pixelate", "mosaic", "censor", "blocks"],
		params: [
			slider({ key: "size", label: "Block size", min: 1, max: 200, defaultValue: 24 }),
		],
		filters: (read, { width, height }) => [
			{
				service: "frei0r.pixeliz0r",
				props: {
					// Fractions of the frame, with the block size given in 1080p pixels.
					"0": read.combine((get) => String(Math.min(1, (get("size") * (height / 1080)) / width))),
					"1": read.combine((get) => String(Math.min(1, (get("size") * (height / 1080)) / height))),
				},
			},
		],
	},
	{
		type: "mlt.posterize",
		name: "Posterize",
		keywords: ["posterize", "levels", "comic", "flat"],
		params: [
			slider({ key: "levels", label: "Levels", min: 2, max: 32, defaultValue: 5 }),
		],
		filters: (read) => [
			{
				service: "frei0r.posterize",
				// frei0r maps 0..1 onto 0..48 levels.
				props: { "0": read.number("levels", (value) => value / 48) },
			},
		],
	},
	{
		type: "mlt.grain",
		name: "Film grain",
		keywords: ["grain", "noise", "film", "texture"],
		params: [
			slider({ key: "amount", label: "Amount", min: 0, max: 100, defaultValue: 30 }),
		],
		filters: (read) => [
			{
				service: "grain",
				props: {
					noise: read.number("amount", (value) => value * 2),
					contrast: 100,
					brightness: 100,
				},
			},
		],
	},
	{
		type: "mlt.oldfilm",
		name: "Old film",
		keywords: ["old", "film", "vintage", "projector", "jitter"],
		params: [],
		filters: () => [
			{ service: "oldfilm", props: {} },
			{ service: "sepia", props: { u: 75, v: 150 } },
		],
	},
	{
		type: "mlt.mirror",
		name: "Mirror",
		keywords: ["mirror", "reflect", "symmetry", "kaleidoscope"],
		params: [
			{
				key: "mode",
				label: "Mode",
				type: "select",
				default: "horizontal",
				keyframable: false,
				options: [
					{ value: "horizontal", label: "Left onto right" },
					{ value: "vertical", label: "Top onto bottom" },
					{ value: "diagonal", label: "Diagonal" },
					{ value: "xdiagonal", label: "Cross diagonal" },
				],
			},
		],
		filters: (read) => [
			{ service: "mirror", props: { mirror: String(read.raw("mode") ?? "horizontal") } },
		],
	},
	{
		type: "mlt.flip",
		name: "Flip",
		keywords: ["flip", "flop", "reverse", "upside down"],
		params: [
			{ key: "horizontal", label: "Horizontal", type: "boolean", default: true, keyframable: false },
			{ key: "vertical", label: "Vertical", type: "boolean", default: false, keyframable: false },
		],
		filters: (read) => [
			...(read.raw("horizontal") ? [{ service: "avfilter.hflip", props: {} }] : []),
			...(read.raw("vertical") ? [{ service: "avfilter.vflip", props: {} }] : []),
		],
	},
	{
		type: "mlt.crop",
		name: "Crop",
		keywords: ["crop", "trim", "cut", "rounded", "frame"],
		params: [
			slider({ key: "left", label: "Left", min: 0, max: 100, defaultValue: 10 }),
			slider({ key: "right", label: "Right", min: 0, max: 100, defaultValue: 10 }),
			slider({ key: "top", label: "Top", min: 0, max: 100, defaultValue: 10 }),
			slider({ key: "bottom", label: "Bottom", min: 0, max: 100, defaultValue: 10 }),
			slider({ key: "radius", label: "Corner radius", min: 0, max: 100, defaultValue: 0 }),
		],
		filters: (read) => [
			{
				service: "qtcrop",
				props: {
					rect: read.combine((get) => {
						const width = Math.max(0, 100 - get("left") - get("right"));
						const height = Math.max(0, 100 - get("top") - get("bottom"));
						return `${get("left")}%/${get("top")}%:${width}%x${height}%`;
					}),
					radius: read.number("radius", percent),
					color: "#00000000",
				},
			},
		],
	},
	{
		type: "mlt.chromakey",
		name: "Chroma key",
		keywords: ["chroma", "key", "green screen", "blue screen", "remove background"],
		params: [
			{ key: "color", label: "Key color", type: "color", default: "#00ff00", keyframable: false },
			slider({ key: "tolerance", label: "Tolerance", min: 0, max: 100, defaultValue: 15 }),
		],
		filters: (read) => [
			{
				service: "chroma",
				props: {
					key: String(read.raw("color") ?? "#00ff00").slice(0, 7),
					variance: read.number("tolerance", percent),
				},
			},
		],
	},
];

const byType = new Map(MLT_EFFECTS.map((effect) => [effect.type, effect]));

export function getMltEffect(type: string): MltEffectDefinition | undefined {
	return byType.get(type);
}

export function isMltEffectType(type: string): boolean {
	return type.startsWith(MLT_EFFECT_PREFIX);
}

import type { TProjectSettings } from "@/project/types";
import type {
	TimelineElement,
	TimelineTrack,
	TScene,
	TextElement,
} from "@/timeline/types";
import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";
import { getMltEffect, isMltEffectType, type MltEffectReader } from "./effects";
import {
	clipTransitionFrames,
	NO_MODIFIERS,
	readTransitions,
} from "./transitions";

/**
 * Converts an OpenCut scene into an MLT XML project that `melt` renders.
 *
 * Pure and synchronous on purpose: no wasm, no DOM, no file access. The caller
 * resolves every media id to an on-disk path first and injects the keyframe sampler.
 */

// Mirrors `TICKS_PER_SECOND` in rust/crates/time. Hardcoded so the converter stays wasm-free.
export const MLT_TICKS_PER_SECOND = 120_000;

/** Key in `media` for audio that came from a URL instead of an imported file. */
export const libraryMediaKey = (sourceUrl: string): string =>
	`library:${sourceUrl}`;

export interface MltMediaSource {
	/** Absolute path of the file melt should read. */
	path: string;
	width?: number;
	height?: number;
	/** Channels of the file's audio, when known. Mono needs a level correction. */
	audioChannels?: number;
}

/**
 * Value of an animatable number at `localTicks` after the element's start. The editor
 * passes its own keyframe resolver so curves are evaluated exactly as in the preview.
 */
export type MltNumberSampler = (args: {
	element: TimelineElement;
	path: string;
	localTicks: number;
	fallback: number;
}) => number;

export interface MltConversionInput {
	projectName: string;
	settings: Pick<TProjectSettings, "fps" | "canvasSize" | "background">;
	scene: Pick<TScene, "tracks">;
	media: ReadonlyMap<string, MltMediaSource>;
	/**
	 * Render size, same aspect ratio as the canvas. melt hangs at the end of a render when
	 * the consumer is asked to resize, so the whole project is laid out at this size instead.
	 */
	outputSize?: { width: number; height: number };
	sampleNumber?: MltNumberSampler;
	/**
	 * Pictures of text, stickers and shapes drawn by the editor, keyed by element id.
	 * Elements without one fall back to MLT's own text, or are skipped.
	 */
	rasters?: ReadonlyMap<string, MltRasterSource>;
	/**
	 * White-on-black pictures of each masked clip's masks, keyed by element id. Without one
	 * the clip is exported unmasked, with a warning.
	 */
	mattes?: ReadonlyMap<string, { path: string }>;
	/**
	 * Picture of the project background, for backgrounds MLT cannot paint itself
	 * (gradients). Without one a non-plain colour falls back to black, with a warning.
	 */
	backgroundImage?: { path: string };
}

export interface MltRasterSource {
	/** Transparent image the size of the output frame. */
	path: string;
	/** True when position, scale, rotation and opacity are already in the image. */
	bakedTransform: boolean;
}

export interface MltConversionResult {
	xml: string;
	warnings: string[];
	totalFrames: number;
}

const esc = (value: string | number): string =>
	String(value)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

const prop = (name: string, value: string | number): string =>
	`<property name="${esc(name)}">${esc(value)}</property>`;

/** CSS "#rrggbb" / "#rrggbbaa" -> MLT colour. MLT puts alpha first: "#aarrggbb". */
const toMltColour = (hex: string): string =>
	hex.length === 9
		? `#${hex.slice(7, 9)}${hex.slice(1, 7)}`
		: `#ff${hex.slice(1, 7)}`;

/** melt reads forward slashes on every platform and they need no XML care. */
const toMltPath = (path: string): string => path.replace(/\\/g, "/");

const num = (value: unknown, fallback: number): number =>
	typeof value === "number" && Number.isFinite(value) ? value : fallback;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10000) / 10000;

const TRANSFORM_PATHS = [
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
	"opacity",
] as const;

// OpenCut uses CSS blend mode names; frei0r.cairoblend has its own spelling.
const CAIRO_BLEND_MODES: Record<string, string> = {
	normal: "normal",
	multiply: "multiply",
	screen: "screen",
	overlay: "overlay",
	darken: "darken",
	lighten: "lighten",
	"color-dodge": "colordodge",
	"color-burn": "colorburn",
	"hard-light": "hardlight",
	"soft-light": "softlight",
	difference: "difference",
	exclusion: "exclusion",
	hue: "hslhue",
	saturation: "hslsaturation",
	color: "hslcolor",
	luminosity: "hslluminosity",
	"plus-lighter": "add",
};

function hasKeys({
	element,
	path,
}: {
	element: TimelineElement;
	path: string;
}): boolean {
	const channel = element.animations?.[path] as
		| { keys?: unknown[] }
		| Record<string, { keys?: unknown[] } | undefined>
		| undefined;
	if (!channel) return false;
	if (Array.isArray((channel as { keys?: unknown[] }).keys)) {
		return ((channel as { keys: unknown[] }).keys.length ?? 0) > 0;
	}
	return Object.values(channel).some(
		(component) => (component?.keys?.length ?? 0) > 0,
	);
}

export function convertToMlt({
	projectName,
	settings,
	scene,
	media,
	outputSize,
	sampleNumber,
	rasters,
	mattes,
	backgroundImage,
}: MltConversionInput): MltConversionResult {
	const warnings: string[] = [];
	const { fps, background } = settings;
	// Everything below is laid out in output pixels; `scale` converts from project pixels.
	const canvasSize = outputSize ?? settings.canvasSize;
	const scale = canvasSize.height / settings.canvasSize.height;

	const ticksPerFrame =
		(MLT_TICKS_PER_SECOND * fps.denominator) / fps.numerator;
	const toFrames = (ticks: number): number => Math.round(ticks / ticksPerFrame);

	const sample: MltNumberSampler =
		sampleNumber ?? (({ fallback }) => fallback);

	/** Builds a filter; `range` makes its keyframes relative to the clip's first frame. */
	const filter = ({
		service,
		props,
		range,
	}: {
		service: string;
		props: string[];
		range?: { inFrame: number; outFrame: number };
	}): string => {
		const attributes = range
			? ` in="${range.inFrame}" out="${range.outFrame}"`
			: "";
		return `<filter${attributes}>${prop("mlt_service", service)}${props.join("")}</filter>`;
	};

	/**
	 * One value per frame, written as an MLT animation string. A frame is kept only where
	 * the value changes: MLT interpolates linearly between keyframes, so the two ends of a
	 * constant run reproduce it exactly.
	 */
	const bake = ({
		length,
		valueAt,
	}: {
		length: number;
		valueAt: (frame: number) => string;
	}): string => {
		const values: string[] = [];
		for (let frame = 0; frame < length; frame++) values.push(valueAt(frame));
		const keyframes: string[] = [];
		for (let frame = 0; frame < length; frame++) {
			const isEdge = frame === 0 || frame === length - 1;
			if (
				isEdge ||
				values[frame] !== values[frame - 1] ||
				values[frame] !== values[frame + 1]
			) {
				keyframes.push(`${frame}=${values[frame]}`);
			}
		}
		return keyframes.join(";");
	};

	/**
	 * Static value, or an MLT animation string with one linear keyframe per frame when the
	 * property is keyframed. Baking keeps every easing curve identical to the editor.
	 */
	const animate = ({
		element,
		paths,
		length,
		format,
		everyFrame = false,
	}: {
		element: TimelineElement;
		paths: readonly string[];
		length: number;
		format: (
			read: (path: string, fallback: number) => number,
			frame: number,
		) => string;
		/** Bake even without keyframes, e.g. while a transition alters the value. */
		everyFrame?: boolean;
	}): string => {
		const isKeyframed =
			sampleNumber !== undefined &&
			paths.some((path) => hasKeys({ element, path }));
		const readStatic = (path: string, fallback: number) =>
			num(element.params[path], fallback);
		const readAt = (localTicks: number) =>
			isKeyframed
				? (path: string, fallback: number) =>
						sample({
							element,
							path,
							localTicks,
							fallback: num(element.params[path], fallback),
						})
				: readStatic;
		if (!isKeyframed && !everyFrame) return format(readStatic, 0);
		return bake({
			length,
			valueAt: (frame) =>
				format(readAt(Math.round(frame * ticksPerFrame)), frame),
		});
	};

	/** Per-frame transition modifiers of a clip, or null when it has none. */
	const transitionsOf = ({
		element,
		length,
	}: {
		element: TimelineElement;
		length: number;
	}) =>
		clipTransitionFrames({
			params: element.params,
			length,
			framesPerSecond: fps.numerator / fps.denominator,
		});

	const usesTransform = ({ element }: { element: TimelineElement }): boolean =>
		readTransitions({ params: element.params }).in !== null ||
		readTransitions({ params: element.params }).out !== null ||
		TRANSFORM_PATHS.some((path) => hasKeys({ element, path })) ||
		num(element.params["transform.positionX"], 0) !== 0 ||
		num(element.params["transform.positionY"], 0) !== 0 ||
		num(element.params["transform.scaleX"], 1) !== 1 ||
		num(element.params["transform.scaleY"], 1) !== 1 ||
		num(element.params["transform.rotate"], 0) !== 0 ||
		num(element.params.opacity, 1) !== 1;

	/**
	 * OpenCut fits a source inside the canvas ("contain"), scales it, then offsets
	 * its centre from the canvas centre. qtblend's rect is the same box, top-left based.
	 */
	const transformFilter = ({
		element,
		sourceWidth,
		sourceHeight,
		range,
	}: {
		element: TimelineElement;
		sourceWidth: number;
		sourceHeight: number;
		range: { inFrame: number; outFrame: number };
	}): string | null => {
		if (!usesTransform({ element })) return null;
		const length = range.outFrame - range.inFrame + 1;
		const containScale = Math.min(
			canvasSize.width / sourceWidth,
			canvasSize.height / sourceHeight,
		);
		const modifiersAt = transitionsOf({ element, length });
		const rect = animate({
			element,
			paths: TRANSFORM_PATHS,
			length,
			everyFrame: modifiersAt !== null,
			format: (read, frame) => {
				const modifiers = modifiersAt?.(frame) ?? NO_MODIFIERS;
				const width =
					Math.abs(sourceWidth * containScale * read("transform.scaleX", 1)) *
					modifiers.scale;
				const height =
					Math.abs(sourceHeight * containScale * read("transform.scaleY", 1)) *
					modifiers.scale;
				const centreX =
					canvasSize.width / 2 +
					read("transform.positionX", 0) * scale +
					modifiers.offsetX * canvasSize.width;
				const centreY =
					canvasSize.height / 2 +
					read("transform.positionY", 0) * scale +
					modifiers.offsetY * canvasSize.height;
				return [
					round2(centreX - width / 2),
					round2(centreY - height / 2),
					round2(width),
					round2(height),
					round2(
						Math.min(1, Math.max(0, read("opacity", 1) * modifiers.opacity)),
					),
				].join(" ");
			},
		});
		const rotation = animate({
			element,
			paths: ["transform.rotate"],
			length,
			format: (read) => String(round2(read("transform.rotate", 0))),
		});
		return filter({
			service: "qtblend",
			range,
			props: [
				prop("rect", rect),
				prop("rotation", rotation),
				prop("rotate_center", 1),
				prop("compositing", 0),
				// Stretch to the rect; it already carries the source aspect ratio.
				prop("distort", 1),
			],
		});
	};

	/**
	 * Wipe transitions: a crop rectangle that grows or shrinks over the clip's own frame,
	 * leaving the rest transparent. Runs before the transform so it follows the clip.
	 */
	const wipeFilter = ({
		element,
		range,
	}: {
		element: TimelineElement;
		range: { inFrame: number; outFrame: number };
	}): string | null => {
		const length = range.outFrame - range.inFrame + 1;
		const modifiersAt = transitionsOf({ element, length });
		if (!modifiersAt) return null;
		const rectAt = (frame: number) => {
			const { left, top, right, bottom } = modifiersAt(frame).reveal;
			return [
				round2(left * canvasSize.width),
				round2(top * canvasSize.height),
				round2(Math.max(0, right - left) * canvasSize.width),
				round2(Math.max(0, bottom - top) * canvasSize.height),
			].join(" ");
		};
		const full = `0 0 ${canvasSize.width} ${canvasSize.height}`;
		let wipes = false;
		for (let frame = 0; frame < length && !wipes; frame++) {
			wipes = rectAt(frame) !== full;
		}
		if (!wipes) return null;
		return filter({
			service: "qtcrop",
			range,
			props: [
				prop("rect", bake({ length, valueAt: rectAt })),
				prop("color", "#00000000"),
			],
		});
	};

	/**
	 * A clip's effects as MLT filters, applied before the transform. `nativeAlreadyDrawn` is
	 * set for rasterised elements, whose picture already contains the editor's own effects.
	 */
	const effectFilters = ({
		element,
		sourceWidth,
		sourceHeight,
		range,
		nativeAlreadyDrawn = false,
	}: {
		element: TimelineElement;
		sourceWidth: number;
		sourceHeight: number;
		range: { inFrame: number; outFrame: number };
		nativeAlreadyDrawn?: boolean;
	}): string[] => {
		if (!("effects" in element) || !element.effects?.length) return [];
		const length = range.outFrame - range.inFrame + 1;
		const containScale = Math.min(
			canvasSize.width / sourceWidth,
			canvasSize.height / sourceHeight,
		);
		const filters: string[] = [];
		for (const effect of element.effects) {
			if (!effect.enabled) continue;
			const pathOf = (key: string) => `effects.${effect.id}.params.${key}`;
			const isKeyframed = (key: string) =>
				sampleNumber !== undefined && hasKeys({ element, path: pathOf(key) });
			const animatedKeys = Object.keys(effect.params).filter(isKeyframed);

			if (isMltEffectType(effect.type)) {
				const definition = getMltEffect(effect.type);
				if (!definition) {
					warnings.push(`${element.name}: effect "${effect.type}" is unknown to this version`);
					continue;
				}
				const baseOf = (key: string) => {
					const fallback = definition.params.find((p) => p.key === key)?.default;
					return num(Number(effect.params[key] ?? fallback), num(Number(fallback), 0));
				};
				const used = new Set<string>();
				const read: MltEffectReader = {
					raw: (key) =>
						effect.params[key] ??
						definition.params.find((p) => p.key === key)?.default,
					number: (key, map = (value) => value) => {
						if (!isKeyframed(key)) return String(round4(map(baseOf(key))));
						used.add(key);
						return bake({
							length,
							valueAt: (frame) =>
								String(
									round4(
										map(
											sample({
												element,
												path: pathOf(key),
												localTicks: Math.round(frame * ticksPerFrame),
												fallback: baseOf(key),
											}),
										),
									),
								),
						});
					},
					combine: (format) => format(baseOf),
				};
				for (const spec of definition.filters(read, {
					width: canvasSize.width,
					height: canvasSize.height,
				})) {
					filters.push(
						filter({
							service: spec.service,
							range,
							props: Object.entries(spec.props).map(([key, value]) =>
								prop(key, value),
							),
						}),
					);
				}
				const ignored = animatedKeys.filter((key) => !used.has(key));
				if (ignored.length > 0) {
					warnings.push(`${element.name}: keyframes on ${definition.name} (${ignored.join(", ")}) are not converted; the current value is used`);
				}
				continue;
			}

			if (nativeAlreadyDrawn) continue;
			if (effect.type === "blur") {
				// Same mapping as effects/definitions/blur.ts: sigma = intensity / 5 at 1920x1080.
				const sigmas = (intensity: number) => ({
					x: Math.max((intensity / 5) * ((sourceWidth * containScale) / 1920), 0.01),
					y: Math.max((intensity / 5) * ((sourceHeight * containScale) / 1080), 0.01),
				});
				const base = num(Number(effect.params.intensity), 15);
				const sigmaAt = (axis: "x" | "y") =>
					isKeyframed("intensity")
						? bake({
								length,
								valueAt: (frame) =>
									String(
										round2(
											sigmas(
												sample({
													element,
													path: pathOf("intensity"),
													localTicks: Math.round(frame * ticksPerFrame),
													fallback: base,
												}),
											)[axis],
										),
									),
							})
						: String(round2(sigmas(base)[axis]));
				if (isKeyframed("intensity") || base > 0) {
					filters.push(
						filter({
							service: "avfilter.gblur",
							range,
							props: [
								prop("av.sigma", sigmaAt("x")),
								prop("av.sigmaV", sigmaAt("y")),
								prop("av.steps", 2),
							],
						}),
					);
				}
			} else {
				warnings.push(`${element.name}: effect "${effect.type}" is not converted yet`);
			}
		}
		return filters;
	};

	const warnUnsupported = ({
		element,
		track,
	}: {
		element: TimelineElement;
		track: TimelineTrack;
	}) => {
		const where = `${track.name} / ${element.name}`;
		if (
			"masks" in element &&
			element.masks?.length &&
			!mattes?.has(element.id)
		) {
			warnings.push(`${where}: masks are not converted yet`);
		}
		const convertedPaths: string[] = [...TRANSFORM_PATHS, "volume"];
		const otherAnimated = Object.keys(element.animations ?? {}).filter(
			(path) =>
				!convertedPaths.includes(path) &&
				!path.startsWith("effects.") &&
				hasKeys({ element, path }),
		);
		if (otherAnimated.length > 0) {
			warnings.push(`${where}: keyframes on ${otherAnimated.join(", ")} are not converted yet`);
		}
	};

	const buildMediaProducer = ({
		element,
		id,
		inFrame,
		outFrame,
	}: {
		element: Extract<TimelineElement, { type: "video" | "image" | "audio" }>;
		id: string;
		inFrame: number;
		outFrame: number;
	}): string | null => {
		const isLibraryAudio =
			element.type === "audio" && element.sourceType === "library";
		const source = media.get(
			isLibraryAudio
				? libraryMediaKey(element.sourceUrl)
				: (element as { mediaId: string }).mediaId,
		);
		if (!source) {
			warnings.push(
				isLibraryAudio
					? `${element.name}: library audio could not be fetched and was skipped`
					: `${element.name}: source file is missing and was skipped`,
			);
			return null;
		}

		const range = { inFrame, outFrame };
		const length = outFrame - inFrame + 1;
		const rate =
			"retime" in element && element.retime ? element.retime.rate : 1;
		const lines: string[] = [];
		if (rate !== 1) {
			// timewarp plays the file at `rate`; its frames are counted on the warped timeline.
			lines.push(
				prop("mlt_service", "timewarp"),
				prop("resource", `${round2(rate)}:${toMltPath(source.path)}`),
				prop("warp_speed", round2(rate)),
				prop("warp_resource", toMltPath(source.path)),
				prop(
					"warp_pitch",
					"retime" in element && element.retime?.maintainPitch ? 1 : 0,
				),
			);
		} else {
			lines.push(prop("resource", toMltPath(source.path)));
		}
		if (element.type === "image") {
			lines.push(prop("length", outFrame + 1), prop("ttl", 1));
		}
		if ("hidden" in element && element.hidden) {
			lines.push(prop("video_index", -1));
		}

		if (element.type !== "image") {
			const silenced =
				element.params.muted === true ||
				(element.type === "video" && element.isSourceAudioEnabled === false);
			if (silenced) {
				lines.push(prop("audio_index", -1));
			} else {
				const modifiersAt = transitionsOf({ element, length });
				let fadesAudio = false;
				for (let frame = 0; modifiersAt && frame < length && !fadesAudio; frame++) {
					fadesAudio = modifiersAt(frame).gain !== 1;
				}
				// melt spreads a mono source over two channels at -3 dB each; the editor plays
				// it at full level on both.
				const monoGain = source.audioChannels === 1 ? 3.0103 : 0;
				if (
					fadesAudio ||
					monoGain !== 0 ||
					num(element.params.volume, 0) !== 0 ||
					hasKeys({ element, path: "volume" })
				) {
					// OpenCut volume is in dB, same unit as the MLT volume filter's `level`.
					// A fade multiplies the gain, which is an offset in dB; -60 dB is silence.
					lines.push(
						filter({
							service: "volume",
							range,
							props: [
								prop(
									"level",
									animate({
										element,
										paths: ["volume"],
										length,
										everyFrame: fadesAudio,
										format: (read, frame) => {
											const gain = modifiersAt?.(frame).gain ?? 1;
											const fade = 20 * Math.log10(Math.max(gain, 0.001));
											return String(round2(read("volume", 0) + fade + monoGain));
										},
									}),
								),
							],
						}),
					);
				}
			}
		}

		if (element.type !== "audio") {
			const sourceWidth = source.width ?? canvasSize.width;
			const sourceHeight = source.height ?? canvasSize.height;
			lines.push(
				...effectFilters({ element, sourceWidth, sourceHeight, range }),
			);
			const matte = mattes?.get(element.id);
			if (matte) {
				// The matte's brightness becomes the clip's alpha, before the clip is placed.
				lines.push(
					filter({
						service: "shape",
						props: [
							prop("resource", toMltPath(matte.path)),
							prop("use_luminance", 1),
							prop("use_mix", 0),
						],
					}),
				);
			}
			const wipe = wipeFilter({ element, range });
			if (wipe) lines.push(wipe);
			// qtblend cannot mirror, so a negative scale is a flip followed by a positive scale.
			if (num(element.params["transform.scaleX"], 1) < 0) {
				lines.push(filter({ service: "avfilter.hflip", props: [] }));
			}
			if (num(element.params["transform.scaleY"], 1) < 0) {
				lines.push(filter({ service: "avfilter.vflip", props: [] }));
			}
			const transform = transformFilter({
				element,
				sourceWidth,
				sourceHeight,
				range,
			});
			if (transform) lines.push(transform);
		}

		// No in/out here: the playlist entry carries the trim. Setting both applies it twice.
		return `<producer id="${id}">\n    ${lines.join("\n    ")}\n  </producer>`;
	};

	const buildRasterProducer = ({
		element,
		raster,
		id,
		outFrame,
	}: {
		element: TimelineElement;
		raster: MltRasterSource;
		id: string;
		outFrame: number;
	}): string => {
		const lines = [
			prop("resource", toMltPath(raster.path)),
			prop("length", outFrame + 1),
			prop("ttl", 1),
		];
		lines.push(
			...effectFilters({
				element,
				sourceWidth: settings.canvasSize.width,
				sourceHeight: settings.canvasSize.height,
				range: { inFrame: 0, outFrame },
				nativeAlreadyDrawn: true,
			}),
		);
		const wipe = wipeFilter({ element, range: { inFrame: 0, outFrame } });
		if (wipe) lines.push(wipe);
		if (!raster.bakedTransform) {
			// The image is the element drawn untransformed on a full canvas.
			const transform = transformFilter({
				element,
				sourceWidth: settings.canvasSize.width,
				sourceHeight: settings.canvasSize.height,
				range: { inFrame: 0, outFrame },
			});
			if (transform) lines.push(transform);
		}
		return `<producer id="${id}">\n    ${lines.join("\n    ")}\n  </producer>`;
	};

	const buildTextProducer = ({
		element,
		id,
		outFrame,
	}: {
		element: TextElement;
		id: string;
		outFrame: number;
	}): string => {
		const p = element.params;
		const size = Math.round(
			num(p.fontSize, 15) * (canvasSize.height / FONT_SIZE_SCALE_REFERENCE),
		);
		const x = Math.round(num(p["transform.positionX"], 0) * scale);
		const y = Math.round(num(p["transform.positionY"], 0) * scale);
		const opacity = Math.min(1, Math.max(0, num(p.opacity, 1)));
		if (p["background.enabled"] === true) {
			warnings.push(`${element.name}: text background is not converted yet`);
		}
		if (
			num(p["transform.scaleX"], 1) !== 1 ||
			num(p["transform.scaleY"], 1) !== 1 ||
			num(p["transform.rotate"], 0) !== 0 ||
			TRANSFORM_PATHS.some((path) => hasKeys({ element, path }))
		) {
			warnings.push(`${element.name}: text scale, rotation and keyframes are not converted yet`);
		}
		const textFilter = filter({
			service: "dynamictext",
			props: [
				// `#` delimits keywords in dynamictext, so literal ones must be escaped.
				prop("argument", String(p.content ?? "").replace(/#/g, "\\#")),
				prop(
					"geometry",
					`${x}/${y}:${canvasSize.width}x${canvasSize.height}:100`,
				),
				prop("family", String(p.fontFamily ?? "Arial")),
				prop("size", size),
				prop("weight", p.fontWeight === "bold" ? 700 : 400),
				prop("style", p.fontStyle === "italic" ? "italic" : "normal"),
				prop("fgcolour", toMltColour(String(p.color ?? "#ffffff"))),
				prop("bgcolour", "#00000000"),
				prop("halign", String(p.textAlign ?? "center")),
				prop("valign", "middle"),
				prop("opacity", opacity),
			],
		});
		return [
			`<producer id="${id}" in="0" out="${outFrame}">`,
			`    ${prop("mlt_service", "color")}`,
			`    ${prop("resource", "#00000000")}`,
			`    ${prop("mlt_image_format", "rgba")}`,
			`    ${prop("length", outFrame + 1)}`,
			`    ${textFilter}`,
			`  </producer>`,
		].join("\n");
	};

	// MLT stacks tracks bottom -> top; OpenCut's overlay[0] is the topmost track.
	const sourceTracks: TimelineTrack[] = [
		scene.tracks.main,
		...[...scene.tracks.overlay].reverse(),
		...scene.tracks.audio,
	];

	const totalFrames = Math.max(
		1,
		...sourceTracks.flatMap((track) =>
			track.elements.map((element) =>
				toFrames(element.startTime + element.duration),
			),
		),
	);
	const lastFrame = totalFrames - 1;

	const producers: string[] = [];
	const playlists: { id: string; xml: string; hide: number; blend: string }[] =
		[];
	let producerCount = 0;
	let playlistCount = 0;

	/**
	 * Blurred background: every picture on the main track, stretched to cover the frame and
	 * blurred, on a track of its own under everything else. Same recipe as the editor's
	 * BlurBackgroundNode, which also ignores the clip's transform and effects.
	 */
	if (background.type === "blur" && !scene.tracks.main.hidden) {
		const intensity = num(background.blurIntensity, 10);
		const entries: string[] = [];
		let cursor = 0;
		const elements = [...scene.tracks.main.elements].sort(
			(a, b) => a.startTime - b.startTime,
		);
		for (const element of elements) {
			if (element.type !== "video" && element.type !== "image") continue;
			if (element.hidden) continue;
			const source = media.get(element.mediaId);
			if (!source) continue;
			const start = toFrames(element.startTime);
			const length = toFrames(element.startTime + element.duration) - start;
			if (length <= 0 || start < cursor) continue;

			const rate =
				element.type === "video" && element.retime ? element.retime.rate : 1;
			const inFrame =
				element.type === "image" ? 0 : toFrames(element.trimStart / rate);
			const outFrame = inFrame + length - 1;
			const sourceWidth = source.width ?? canvasSize.width;
			const sourceHeight = source.height ?? canvasSize.height;
			const coverScale = Math.max(
				canvasSize.width / sourceWidth,
				canvasSize.height / sourceHeight,
			);
			const width = sourceWidth * coverScale;
			const height = sourceHeight * coverScale;
			const lines =
				rate !== 1
					? [
							prop("mlt_service", "timewarp"),
							prop("resource", `${round2(rate)}:${toMltPath(source.path)}`),
							prop("warp_speed", round2(rate)),
							prop("warp_resource", toMltPath(source.path)),
						]
					: [prop("resource", toMltPath(source.path))];
			if (element.type === "image") {
				lines.push(prop("length", outFrame + 1), prop("ttl", 1));
			}
			lines.push(
				prop("audio_index", -1),
				filter({
					service: "qtblend",
					props: [
						prop(
							"rect",
							[
								round2((canvasSize.width - width) / 2),
								round2((canvasSize.height - height) / 2),
								round2(width),
								round2(height),
								1,
							].join(" "),
						),
						prop("compositing", 0),
						prop("distort", 1),
					],
				}),
			);
			// Same mapping as the editor: sigma = intensity / 5 on a 1920x1080 frame.
			const sigmaX = (intensity / 5) * (canvasSize.width / 1920);
			const sigmaY = (intensity / 5) * (canvasSize.height / 1080);
			if (Math.max(sigmaX, sigmaY) >= 0.01) {
				lines.push(
					filter({
						service: "avfilter.gblur",
						props: [
							prop("av.sigma", round2(sigmaX)),
							prop("av.sigmaV", round2(sigmaY)),
							prop("av.steps", 3),
						],
					}),
				);
			}

			const id = `backdrop${producers.length}`;
			producers.push(
				`<producer id="${id}">\n    ${lines.join("\n    ")}\n  </producer>`,
			);
			if (start > cursor) entries.push(`<blank length="${start - cursor}"/>`);
			entries.push(
				`<entry producer="${id}" in="${inFrame}" out="${outFrame}"/>`,
			);
			cursor = start + length;
		}
		if (entries.length > 0) {
			playlists.push({
				id: "backdrop_track",
				xml: `<playlist id="backdrop_track">\n    ${entries.join("\n    ")}\n  </playlist>`,
				hide: 2,
				blend: "normal",
			});
		}
	}

	for (const track of sourceTracks) {
		/**
		 * A blend mode belongs to the MLT transition, which is per track. Elements with
		 * different modes on one OpenCut track therefore go to adjacent MLT tracks.
		 */
		const byBlend = new Map<string, TimelineElement[]>();
		byBlend.set("normal", []);
		for (const element of track.elements) {
			const requested = String(element.params.blendMode ?? "normal");
			let mode = CAIRO_BLEND_MODES[requested];
			if (!mode) {
				warnings.push(`${track.name} / ${element.name}: blend mode "${requested}" is not supported; using normal`);
				mode = "normal";
			}
			if (!byBlend.has(mode)) byBlend.set(mode, []);
			byBlend.get(mode)?.push(element);
		}

		for (const [blend, blendElements] of byBlend) {
			if (blend !== "normal" && blendElements.length === 0) continue;
			const entries: string[] = [];
			let cursor = 0;
			const elements = [...blendElements].sort(
				(a, b) => a.startTime - b.startTime,
			);

			for (const element of elements) {
				const start = toFrames(element.startTime);
				const length = toFrames(element.startTime + element.duration) - start;
				if (length <= 0) continue;
				if (start < cursor) {
					warnings.push(`${track.name} / ${element.name}: overlaps the previous clip and was skipped`);
					continue;
				}

				const id = `producer${producerCount++}`;
				let inFrame = 0;
				let producer: string | null;
				if (
					element.type === "video" ||
					element.type === "audio" ||
					element.type === "image"
				) {
					const rate =
						"retime" in element && element.retime ? element.retime.rate : 1;
					inFrame =
						element.type === "image" ? 0 : toFrames(element.trimStart / rate);
					producer = buildMediaProducer({
						element,
						id,
						inFrame,
						outFrame: inFrame + length - 1,
					});
				} else if (rasters?.has(element.id)) {
					producer = buildRasterProducer({
						element,
						raster: rasters.get(element.id) as MltRasterSource,
						id,
						outFrame: length - 1,
					});
				} else if (element.type === "text") {
					producer = buildTextProducer({ element, id, outFrame: length - 1 });
				} else {
					warnings.push(`${track.name} / ${element.name}: "${element.type}" elements are not converted yet`);
					producer = null;
				}
				if (!producer) continue;

				producers.push(producer);
				warnUnsupported({ element, track });
				if (start > cursor) entries.push(`<blank length="${start - cursor}"/>`);
				entries.push(
					`<entry producer="${id}" in="${inFrame}" out="${inFrame + length - 1}"/>`,
				);
				cursor = start + length;
			}

			const hidden = "hidden" in track && track.hidden;
			const muted = "muted" in track && track.muted;
			const id = `playlist${playlistCount++}`;
			playlists.push({
				id,
				xml: `<playlist id="${id}">\n    ${entries.join("\n    ")}\n  </playlist>`,
				// MLT `hide`: 1 = no video, 2 = no audio
				hide: (hidden || track.type === "audio" ? 1 : 0) + (muted ? 2 : 0),
				blend,
			});
		}
	}

	// Under a blurred background the gaps between main-track clips stay black, as in the editor.
	let backgroundColour = "#000000ff";
	if (background.type === "color" && background.color !== "transparent") {
		if (/^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(background.color)) {
			backgroundColour = toMltColour(background.color);
		} else if (!backgroundImage) {
			warnings.push("The background is not a plain colour and was not drawn; using black");
		}
	}
	const backgroundProducer =
		background.type === "color" && backgroundImage
			? `${prop("resource", toMltPath(backgroundImage.path))}
    ${prop("length", totalFrames)}
    ${prop("ttl", 1)}`
			: `${prop("mlt_service", "color")}
    ${prop("resource", backgroundColour)}
    ${prop("length", totalFrames)}`;

	const transitions = playlists.flatMap((playlist, index) => {
		const bTrack = index + 1; // track 0 is the background
		return [
			`<transition in="0" out="${lastFrame}">${prop("mlt_service", "mix")}${prop("a_track", 0)}${prop("b_track", bTrack)}${prop("always_active", 1)}${prop("sum", 1)}</transition>`,
			`<transition in="0" out="${lastFrame}">${prop("mlt_service", "frei0r.cairoblend")}${prop("a_track", 0)}${prop("b_track", bTrack)}${prop("always_active", 1)}${playlist.blend === "normal" ? "" : prop("1", playlist.blend)}</transition>`,
		];
	});

	const hideAttribute: Record<number, string> = {
		1: ' hide="video"',
		2: ' hide="audio"',
		3: ' hide="both"',
	};

	const xml = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.0.0" producer="main_tractor">
  <profile description="${esc(projectName)}" width="${canvasSize.width}" height="${canvasSize.height}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${canvasSize.width}" display_aspect_den="${canvasSize.height}" frame_rate_num="${fps.numerator}" frame_rate_den="${fps.denominator}" colorspace="709"/>
  <producer id="background" in="0" out="${lastFrame}">
    ${backgroundProducer}
  </producer>
  <playlist id="background_track">
    <entry producer="background" in="0" out="${lastFrame}"/>
  </playlist>
  ${producers.join("\n  ")}
  ${playlists.map((playlist) => playlist.xml).join("\n  ")}
  <tractor id="main_tractor" in="0" out="${lastFrame}">
    <track producer="background_track"/>
    ${playlists
			.map(
				(playlist) =>
					`<track producer="${playlist.id}"${hideAttribute[playlist.hide] ?? ""}/>`,
			)
			.join("\n    ")}
    ${transitions.join("\n    ")}
  </tractor>
</mlt>
`;

	return { xml, warnings, totalFrames };
}

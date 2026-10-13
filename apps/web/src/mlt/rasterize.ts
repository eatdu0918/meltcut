import type { FrameRate } from "opencut-wasm";
import type { MediaAsset } from "@/media/types";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";
import type {
	GraphicElement,
	ImageElement,
	MaskableElement,
	SceneTracks,
	StickerElement,
	TextElement,
	TimelineElement,
} from "@/timeline/types";
import { ZERO_MEDIA_TIME } from "@/wasm";
import { readTransitions } from "./transitions";

/**
 * Text, stickers and shapes are drawn by the editor's own renderer and handed to MLT as
 * transparent images. MLT's text engine lays out glyphs differently, and it has no
 * equivalent for the editor's shapes, so this is the only way to match the preview.
 */
export type RasterizableElement = TextElement | StickerElement | GraphicElement;

export function isRasterizable(
	element: TimelineElement,
): element is RasterizableElement {
	return (
		element.type === "text" ||
		element.type === "sticker" ||
		element.type === "graphic"
	);
}

const TRANSFORM_PATHS = [
	"transform.positionX",
	"transform.positionY",
	"transform.scaleX",
	"transform.scaleY",
	"transform.rotate",
	"opacity",
];

export function hasTransformKeyframes({
	element,
}: {
	element: TimelineElement;
}): boolean {
	return TRANSFORM_PATHS.some((path) => element.animations?.[path]);
}

/**
 * True when MLT has to move or fade the element itself, so its picture must be drawn
 * untransformed: transform keyframes, or a transition.
 */
export function needsLiveTransform({
	element,
}: {
	element: TimelineElement;
}): boolean {
	const transitions = readTransitions({ params: element.params });
	return (
		hasTransformKeyframes({ element }) ||
		transitions.in !== null ||
		transitions.out !== null
	);
}

/**
 * A copy of the element as it should be drawn into the image.
 *
 * With `bakeTransform` the image already contains position, scale, rotation and opacity,
 * which keeps scaled-up text sharp. When those are keyframed the image is drawn untransformed
 * and MLT animates it instead.
 */
function prepareElement({
	element,
	bakeTransform,
}: {
	element: RasterizableElement;
	bakeTransform: boolean;
}): RasterizableElement {
	const params = { ...element.params, blendMode: "normal" };
	if (!bakeTransform) {
		Object.assign(params, {
			"transform.positionX": 0,
			"transform.positionY": 0,
			"transform.scaleX": 1,
			"transform.scaleY": 1,
			"transform.rotate": 0,
			opacity: 1,
		});
	}
	const animations = { ...(element.animations ?? {}) };
	for (const path of TRANSFORM_PATHS) delete animations[path];
	return {
		...element,
		startTime: ZERO_MEDIA_TIME,
		trimStart: ZERO_MEDIA_TIME,
		hidden: false,
		params,
		animations,
	} as RasterizableElement;
}

export async function rasterizeElement({
	element,
	bakeTransform,
	canvasSize,
	outputSize,
	fps,
	mediaAssets,
}: {
	element: RasterizableElement;
	bakeTransform: boolean;
	canvasSize: { width: number; height: number };
	outputSize: { width: number; height: number };
	fps: FrameRate;
	mediaAssets: MediaAsset[];
}): Promise<Blob> {
	const prepared = prepareElement({ element, bakeTransform });
	const tracks = {
		main: {
			id: "raster-main",
			name: "Main",
			type: "video",
			elements: [],
			muted: false,
			hidden: false,
		},
		overlay: [
			{
				id: "raster-overlay",
				name: "Raster",
				type: prepared.type === "text" ? "text" : "graphic",
				elements: [prepared],
				hidden: false,
			},
		],
		audio: [],
	} as unknown as SceneTracks;

	// The editor's compositor always produces an opaque picture, so transparency is
	// recovered by drawing the element on black and on white: where the two differ, the
	// background showed through. alpha = 1 - (onWhite - onBlack), colour = onBlack / alpha.
	const renderOn = async (color: string): Promise<Uint8ClampedArray> => {
		const scene = buildScene({
			tracks,
			mediaAssets,
			duration: prepared.duration,
			canvasSize,
			background: { type: "color", color },
		});
		const renderer = new CanvasRenderer({
			width: canvasSize.width,
			height: canvasSize.height,
			fps,
		});
		const canvas = document.createElement("canvas");
		canvas.width = outputSize.width;
		canvas.height = outputSize.height;
		await renderer.renderToCanvas({ node: scene, time: 0, targetCanvas: canvas });
		const context = canvas.getContext("2d");
		if (!context) throw new Error("No 2D context for rasterising");
		return context.getImageData(0, 0, canvas.width, canvas.height).data;
	};

	const onBlack = await renderOn("#000000");
	const onWhite = await renderOn("#ffffff");
	const output = new ImageData(outputSize.width, outputSize.height);
	for (let i = 0; i < onBlack.length; i += 4) {
		const difference =
			(onWhite[i] - onBlack[i] +
				(onWhite[i + 1] - onBlack[i + 1]) +
				(onWhite[i + 2] - onBlack[i + 2])) /
			3;
		const alpha = Math.min(255, Math.max(0, 255 - difference));
		if (alpha <= 0) continue;
		const unpremultiply = 255 / alpha;
		output.data[i] = Math.min(255, onBlack[i] * unpremultiply);
		output.data[i + 1] = Math.min(255, onBlack[i + 1] * unpremultiply);
		output.data[i + 2] = Math.min(255, onBlack[i + 2] * unpremultiply);
		output.data[i + 3] = alpha;
	}

	const canvas = document.createElement("canvas");
	canvas.width = outputSize.width;
	canvas.height = outputSize.height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("No 2D context for rasterising");
	context.putImageData(output, 0, 0);

	return new Promise<Blob>((resolve, reject) => {
		canvas.toBlob(
			(blob) =>
				blob ? resolve(blob) : reject(new Error("Could not encode the image")),
			"image/png",
		);
	});
}

/** True for a plain "#rrggbb" / "#rrggbbaa" colour, which MLT can paint itself. */
export function isPlainColour(color: string): boolean {
	return /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color);
}

/**
 * Draws a project background the editor paints but MLT cannot describe, such as a gradient.
 */
export async function rasterizeBackground({
	color,
	canvasSize,
	outputSize,
	fps,
}: {
	color: string;
	canvasSize: { width: number; height: number };
	outputSize: { width: number; height: number };
	fps: FrameRate;
}): Promise<Blob> {
	const tracks = {
		main: {
			id: "background-main",
			name: "Main",
			type: "video",
			elements: [],
			muted: false,
			hidden: false,
		},
		overlay: [],
		audio: [],
	} as unknown as SceneTracks;
	const scene = buildScene({
		tracks,
		mediaAssets: [],
		duration: 1,
		canvasSize,
		background: { type: "color", color },
	});
	const canvas = document.createElement("canvas");
	canvas.width = outputSize.width;
	canvas.height = outputSize.height;
	await new CanvasRenderer({
		width: canvasSize.width,
		height: canvasSize.height,
		fps,
	}).renderToCanvas({ node: scene, time: 0, targetCanvas: canvas });
	return new Promise<Blob>((resolve, reject) =>
		canvas.toBlob(
			(blob) =>
				blob
					? resolve(blob)
					: reject(new Error("Could not encode the background")),
			"image/png",
		),
	);
}

/** Stable short key for caching a rasterised element. */
export function rasterKey({
	element,
	bakeTransform,
	outputSize,
}: {
	element: RasterizableElement;
	bakeTransform: boolean;
	outputSize: { width: number; height: number };
}): string {
	const prepared = prepareElement({ element, bakeTransform });
	// Where and how long the element sits on the timeline does not change its picture.
	const { id: _id, name: _name, startTime: _start, duration: _duration, trimEnd: _trimEnd, ...visual } =
		prepared as RasterizableElement & { trimEnd?: unknown };
	const text = JSON.stringify([visual, outputSize]);
	// FNV-1a, twice with different seeds: plenty for a cache key.
	const hash = (seed: number) => {
		let h = seed;
		for (let i = 0; i < text.length; i++) {
			h ^= text.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
		return (h >>> 0).toString(16).padStart(8, "0");
	};
	return `${hash(2166136261)}${hash(84696351)}`;
}

const MATTE_MEDIA_ID = "__mlt_mask_matte__";

/**
 * Draws an element's masks as a white-on-black picture. MLT copies its brightness into the
 * clip's alpha, which reproduces every mask shape and feather the editor can draw.
 *
 * The stand-in is a plain white image with the source's dimensions, drawn untransformed, so
 * the matte lines up with the clip before MLT moves or scales it.
 */
export async function rasterizeMaskMatte({
	element,
	sourceWidth,
	sourceHeight,
	canvasSize,
	outputSize,
	fps,
}: {
	element: MaskableElement;
	sourceWidth: number;
	sourceHeight: number;
	canvasSize: { width: number; height: number };
	outputSize: { width: number; height: number };
	fps: FrameRate;
}): Promise<Blob> {
	const white = document.createElement("canvas");
	white.width = Math.max(2, Math.round(sourceWidth));
	white.height = Math.max(2, Math.round(sourceHeight));
	const whiteContext = white.getContext("2d");
	if (!whiteContext) throw new Error("No 2D context for the mask matte");
	whiteContext.fillStyle = "#ffffff";
	whiteContext.fillRect(0, 0, white.width, white.height);
	const whiteBlob = await new Promise<Blob>((resolve, reject) =>
		white.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error("matte source"))),
			"image/png",
		),
	);
	const file = new File([whiteBlob], "matte.png", { type: "image/png" });
	const url = URL.createObjectURL(file);

	try {
		const standIn = {
			id: "matte-element",
			type: "image",
			mediaId: MATTE_MEDIA_ID,
			name: "matte",
			startTime: ZERO_MEDIA_TIME,
			trimStart: ZERO_MEDIA_TIME,
			trimEnd: ZERO_MEDIA_TIME,
			duration: element.duration,
			hidden: false,
			masks: element.masks,
			params: {
				"transform.positionX": 0,
				"transform.positionY": 0,
				"transform.scaleX": 1,
				"transform.scaleY": 1,
				"transform.rotate": 0,
				opacity: 1,
				blendMode: "normal",
			},
		} as unknown as ImageElement;
		const tracks = {
			main: {
				id: "matte-main",
				name: "Main",
				type: "video",
				elements: [standIn],
				muted: false,
				hidden: false,
			},
			overlay: [],
			audio: [],
		} as unknown as SceneTracks;
		const scene = buildScene({
			tracks,
			mediaAssets: [
				{
					id: MATTE_MEDIA_ID,
					name: "matte.png",
					type: "image",
					file,
					url,
					width: white.width,
					height: white.height,
				},
			],
			duration: element.duration,
			canvasSize,
			background: { type: "color", color: "#000000" },
		});
		const renderer = new CanvasRenderer({
			width: canvasSize.width,
			height: canvasSize.height,
			fps,
		});
		const canvas = document.createElement("canvas");
		canvas.width = outputSize.width;
		canvas.height = outputSize.height;
		await renderer.renderToCanvas({ node: scene, time: 0, targetCanvas: canvas });
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(blob) =>
					blob ? resolve(blob) : reject(new Error("Could not encode the matte")),
				"image/png",
			),
		);
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Stable short key for caching a mask matte. */
export function matteKey({
	element,
	sourceWidth,
	sourceHeight,
	outputSize,
}: {
	element: MaskableElement;
	sourceWidth: number;
	sourceHeight: number;
	outputSize: { width: number; height: number };
}): string {
	const text = JSON.stringify([
		element.masks,
		sourceWidth,
		sourceHeight,
		outputSize,
	]);
	let a = 2166136261;
	let b = 84696351;
	for (let i = 0; i < text.length; i++) {
		a = Math.imul(a ^ text.charCodeAt(i), 16777619);
		b = Math.imul(b ^ text.charCodeAt(i), 16777619);
	}
	const hex = (value: number) => (value >>> 0).toString(16).padStart(8, "0");
	return `${hex(a)}${hex(b)}`;
}

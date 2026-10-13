import { resolveAnimationPathValueAtTime } from "@/animation";
import type { EditorCore } from "@/core";
import { getDesktopBridge, type DesktopBridge } from "@/desktop/bridge";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import type { TimelineTrack } from "@/timeline/types";
import {
	convertToMlt,
	libraryMediaKey,
	type MltMediaSource,
	type MltRasterSource,
} from "./convert";
import {
	needsLiveTransform,
	isPlainColour,
	isRasterizable,
	matteKey,
	rasterizeBackground,
	rasterizeElement,
	rasterizeMaskMatte,
	rasterKey,
} from "./rasterize";
import { MASKABLE_ELEMENT_TYPES, type MaskableElement } from "@/timeline/types";

/**
 * Glue between the editor state and the shell's MLT renderer: resolves media to
 * files on disk, converts the active scene, and runs the render job.
 */

function extensionOf({ name, fallback }: { name: string; fallback: string }): string {
	const match = /\.[A-Za-z0-9]{1,8}$/.exec(name);
	return match ? match[0] : fallback;
}

function usedMediaIds({ tracks }: { tracks: TimelineTrack[] }): Set<string> {
	const ids = new Set<string>();
	for (const track of tracks) {
		for (const element of track.elements) {
			if ("mediaId" in element && element.mediaId) ids.add(element.mediaId);
		}
	}
	return ids;
}

/**
 * Bytes of a media asset. Right after import `asset.file` still points at the original
 * on disk, which may be gone by now; the copy in browser storage is the reliable source.
 */
async function readMediaBytes({
	asset,
	projectId,
}: {
	asset: MediaAsset;
	projectId: string;
}): Promise<ArrayBuffer> {
	const stored = await storageService
		.loadMediaAsset({ projectId, id: asset.id })
		.catch(() => null);
	if (stored) {
		if (stored.url) URL.revokeObjectURL(stored.url);
		return stored.file.arrayBuffer();
	}
	return asset.file.arrayBuffer();
}

// Media copied into the shell cache this session: asset id -> cached path.
const cachedMediaPaths = new Map<string, string>();

// Channel counts read this session: path -> channels (null when the file has no audio).
const audioChannelCounts = new Map<string, number | null>();

async function audioChannelsOf({
	bridge,
	path,
}: {
	bridge: DesktopBridge;
	path: string;
}): Promise<number | undefined> {
	if (!audioChannelCounts.has(path)) {
		audioChannelCounts.set(
			path,
			await bridge.mlt.audioChannels(path).catch(() => null),
		);
	}
	return audioChannelCounts.get(path) ?? undefined;
}

/**
 * Every media file the timeline uses, as a path melt can read. Media without a usable
 * original (pasted, moved, or imported in a browser) is copied into the shell's cache once.
 */
async function resolveMediaSources({
	bridge,
	assets,
	mediaIds,
	projectId,
}: {
	bridge: DesktopBridge;
	assets: MediaAsset[];
	mediaIds: Set<string>;
	projectId: string;
}): Promise<Map<string, MltMediaSource>> {
	const sources = new Map<string, MltMediaSource>();
	for (const asset of assets) {
		if (!mediaIds.has(asset.id)) continue;
		let path = asset.filePath;
		if (!path || !(await bridge.fileExists(path))) {
			path = cachedMediaPaths.get(asset.id);
		}
		// The preview converts on every frame, so a cached copy must be written only once.
		if (!path || !(await bridge.fileExists(path))) {
			path = await bridge.cacheMedia({
				id: asset.id,
				extension: extensionOf({
					name: asset.name,
					fallback: asset.type === "image" ? ".png" : asset.type === "audio" ? ".wav" : ".mp4",
				}),
				data: await readMediaBytes({ asset, projectId }),
			});
			cachedMediaPaths.set(asset.id, path);
		}
		sources.set(asset.id, {
			path,
			width: asset.width,
			height: asset.height,
			audioChannels:
				asset.type === "image"
					? undefined
					: await audioChannelsOf({ bridge, path }),
		});
	}
	return sources;
}

/**
 * Audio that was added from a URL (the sound library) has no imported file, so it is
 * fetched once and kept in the shell's cache. A sound that cannot be fetched is left out
 * and the converter reports it.
 */
async function resolveLibraryAudio({
	bridge,
	tracks,
	sources,
}: {
	bridge: DesktopBridge;
	tracks: TimelineTrack[];
	sources: Map<string, MltMediaSource>;
}): Promise<void> {
	for (const track of tracks) {
		for (const element of track.elements) {
			if (element.type !== "audio" || element.sourceType !== "library") continue;
			const key = libraryMediaKey(element.sourceUrl);
			if (sources.has(key)) continue;
			let path = cachedMediaPaths.get(key);
			if (!path || !(await bridge.fileExists(path))) {
				try {
					const response = await fetch(element.sourceUrl);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					let hash = 2166136261;
					for (let i = 0; i < key.length; i++) {
						hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
					}
					path = await bridge.cacheMedia({
						id: `library-${(hash >>> 0).toString(16).padStart(8, "0")}-${key.length}`,
						extension: extensionOf({
							name: element.sourceUrl.split(/[?#]/)[0],
							fallback: ".mp3",
						}),
						data: await response.arrayBuffer(),
					});
					cachedMediaPaths.set(key, path);
				} catch {
					continue;
				}
			}
			sources.set(key, {
				path,
				audioChannels: await audioChannelsOf({ bridge, path }),
			});
		}
	}
}

// Rasterised elements written to the shell cache this session: raster key -> path.
const rasterPaths = new Map<string, string>();

/**
 * Draws every text, sticker and shape with the editor's renderer and stores the pictures
 * where melt can read them. Unchanged elements reuse the picture from the last call.
 */
async function resolveRasters({
	bridge,
	editor,
	tracks,
	outputSize,
	warnings,
}: {
	bridge: DesktopBridge;
	editor: EditorCore;
	tracks: TimelineTrack[];
	outputSize: { width: number; height: number };
	warnings: string[];
}): Promise<Map<string, MltRasterSource>> {
	const { canvasSize, fps } = editor.project.getActive().settings;
	const rasters = new Map<string, MltRasterSource>();
	for (const track of tracks) {
		for (const element of track.elements) {
			if (!isRasterizable(element)) continue;
			const bakeTransform = !needsLiveTransform({ element });
			const key = rasterKey({ element, bakeTransform, outputSize });
			let path = rasterPaths.get(key);
			if (!path || !(await bridge.fileExists(path))) {
				try {
					const image = await rasterizeElement({
						element,
						bakeTransform,
						canvasSize,
						outputSize,
						fps,
						mediaAssets: editor.media.getAssets(),
					});
					path = await bridge.cacheMedia({
						id: `raster-${key}`,
						extension: ".png",
						data: await image.arrayBuffer(),
					});
					rasterPaths.set(key, path);
				} catch (error) {
					warnings.push(
						`${element.name}: could not be drawn (${error instanceof Error ? error.message : String(error)})`,
					);
					continue;
				}
			}
			rasters.set(element.id, { path, bakedTransform: bakeTransform });
		}
	}
	return rasters;
}

/** Draws the masks of every masked clip as a matte picture melt can read. */
async function resolveMattes({
	bridge,
	editor,
	tracks,
	outputSize,
	warnings,
}: {
	bridge: DesktopBridge;
	editor: EditorCore;
	tracks: TimelineTrack[];
	outputSize: { width: number; height: number };
	warnings: string[];
}): Promise<Map<string, { path: string }>> {
	const { canvasSize, fps } = editor.project.getActive().settings;
	const assets = new Map(editor.media.getAssets().map((a) => [a.id, a]));
	const mattes = new Map<string, { path: string }>();
	for (const track of tracks) {
		for (const element of track.elements) {
			const isMaskable = (MASKABLE_ELEMENT_TYPES as readonly string[]).includes(
				element.type,
			);
			const masked = element as MaskableElement;
			// Shapes are rasterised whole, masks included; only clips need a matte.
			if (!isMaskable || element.type === "graphic" || !masked.masks?.length) {
				continue;
			}
			const asset =
				"mediaId" in element ? assets.get(element.mediaId) : undefined;
			const sourceWidth = asset?.width ?? canvasSize.width;
			const sourceHeight = asset?.height ?? canvasSize.height;
			const key = `matte-${matteKey({ element: masked, sourceWidth, sourceHeight, outputSize })}`;
			let path = rasterPaths.get(key);
			if (!path || !(await bridge.fileExists(path))) {
				try {
					const image = await rasterizeMaskMatte({
						element: masked,
						sourceWidth,
						sourceHeight,
						canvasSize,
						outputSize,
						fps,
					});
					path = await bridge.cacheMedia({
						id: key,
						extension: ".png",
						data: await image.arrayBuffer(),
					});
					rasterPaths.set(key, path);
				} catch (error) {
					warnings.push(
						`${element.name}: mask could not be drawn (${error instanceof Error ? error.message : String(error)})`,
					);
					continue;
				}
			}
			mattes.set(element.id, { path });
		}
	}
	return mattes;
}

/** Draws a gradient background as a picture; plain colours need none. */
async function resolveBackgroundImage({
	bridge,
	editor,
	outputSize,
	warnings,
}: {
	bridge: DesktopBridge;
	editor: EditorCore;
	outputSize: { width: number; height: number };
	warnings: string[];
}): Promise<{ path: string } | undefined> {
	const { canvasSize, fps, background } = editor.project.getActive().settings;
	if (
		background.type !== "color" ||
		background.color === "transparent" ||
		isPlainColour(background.color)
	) {
		return undefined;
	}
	const key = `background-${matteKey({
		element: { masks: [background.color] } as unknown as MaskableElement,
		sourceWidth: canvasSize.width,
		sourceHeight: canvasSize.height,
		outputSize,
	})}`;
	let path = rasterPaths.get(key);
	if (!path || !(await bridge.fileExists(path))) {
		try {
			const image = await rasterizeBackground({
				color: background.color,
				canvasSize,
				outputSize,
				fps,
			});
			path = await bridge.cacheMedia({
				id: key,
				extension: ".png",
				data: await image.arrayBuffer(),
			});
			rasterPaths.set(key, path);
		} catch (error) {
			warnings.push(
				`Background could not be drawn (${error instanceof Error ? error.message : String(error)})`,
			);
			return undefined;
		}
	}
	return { path };
}

export interface BuiltMltProject {
	xml: string;
	warnings: string[];
	totalFrames: number;
}

export async function buildMltProject({
	editor,
	bridge,
	outputSize,
}: {
	editor: EditorCore;
	bridge: DesktopBridge;
	outputSize?: { width: number; height: number };
}): Promise<BuiltMltProject> {
	const project = editor.project.getActive();
	const scene = editor.scenes.getActiveScene();
	const tracks = [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio];
	const media = await resolveMediaSources({
		bridge,
		assets: editor.media.getAssets(),
		mediaIds: usedMediaIds({ tracks }),
		projectId: project.metadata.id,
	});
	await resolveLibraryAudio({ bridge, tracks, sources: media });
	const rasterWarnings: string[] = [];
	const rasters = await resolveRasters({
		bridge,
		editor,
		tracks,
		outputSize: outputSize ?? project.settings.canvasSize,
		warnings: rasterWarnings,
	});
	const mattes = await resolveMattes({
		bridge,
		editor,
		tracks,
		outputSize: outputSize ?? project.settings.canvasSize,
		warnings: rasterWarnings,
	});
	const backgroundImage = await resolveBackgroundImage({
		bridge,
		editor,
		outputSize: outputSize ?? project.settings.canvasSize,
		warnings: rasterWarnings,
	});
	const result = convertToMlt({
		projectName: project.metadata.name,
		settings: project.settings,
		scene,
		media,
		outputSize,
		rasters,
		mattes,
		backgroundImage,
		// Keyframes are evaluated by the editor's own resolver, so easing matches the preview.
		sampleNumber: ({ element, path, localTicks, fallback }) =>
			resolveAnimationPathValueAtTime({
				animations: element.animations,
				propertyPath: path,
				localTime: localTicks,
				fallbackValue: fallback,
			}),
	});
	return { ...result, warnings: [...rasterWarnings, ...result.warnings] };
}

let jobCounter = 0;

export interface MltExportHandle {
	jobId: string;
	done: Promise<{
		ok: boolean;
		cancelled?: boolean;
		error?: string;
		outputPath?: string;
		warnings: string[];
	}>;
	cancel: () => void;
}

export function startMltExport({
	editor,
	outputPath,
	outputSize,
	properties,
	onProgress,
}: {
	editor: EditorCore;
	outputPath: string;
	outputSize?: { width: number; height: number };
	properties: Record<string, string | number>;
	onProgress: (progress: number) => void;
}): MltExportHandle {
	const bridge = getDesktopBridge();
	if (!bridge) throw new Error("The MLT engine is only available in the desktop app.");

	const jobId = `export-${Date.now()}-${++jobCounter}`;
	const unsubscribe = bridge.mlt.onProgress((payload) => {
		if (payload.jobId === jobId) onProgress(payload.progress);
	});

	let cancelled = false;
	const done = (async () => {
		try {
			const { xml, warnings } = await buildMltProject({
				editor,
				bridge,
				outputSize,
			});
			if (cancelled) return { ok: false, cancelled: true, warnings };
			if (!/<entry producer="producer\d+"/.test(xml)) {
				return {
					ok: false,
					error: "Nothing to export: the timeline has no clips the MLT engine can render.",
					warnings,
				};
			}
			const result = await bridge.mlt.render({ jobId, xml, outputPath, properties });
			return {
				ok: result.ok,
				cancelled: result.cancelled,
				outputPath: result.outputPath,
				error: result.ok || result.cancelled
					? undefined
					: [result.error, result.log].filter(Boolean).join("\n"),
				warnings,
			};
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
				warnings: [],
			};
		} finally {
			unsubscribe();
		}
	})();

	return {
		jobId,
		done,
		cancel: () => {
			cancelled = true;
			void bridge.mlt.cancel(jobId);
		},
	};
}

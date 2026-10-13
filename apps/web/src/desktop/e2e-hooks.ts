import { EditorCore } from "@/core";
import { buildMltProject, startMltExport } from "@/mlt/export";
import {
	MLT_EXPORT_PRESETS,
	buildConsumerProperties,
	resolveOutputSize,
	type MltQuality,
	type MltResolutionId,
} from "@/mlt/presets";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";
import {
	buildElementFromMedia,
	buildGraphicElement,
	buildStickerElement,
	buildTextElement,
} from "@/timeline/element-utils";
import { resolveStickerIntrinsicSize } from "@/stickers";
import { MLT_TICKS_PER_SECOND } from "@/mlt/convert";
import { buildDefaultMaskInstance } from "@/masks";
import { mediaTimeFromSeconds } from "@/wasm";
import { getDesktopBridge } from "./bridge";
import { saveProjectFile } from "./project-file";

/**
 * Installs `window.__e2e` so the shell's e2e scripts can set up a timeline without
 * simulating drags. Only active when the shell was started in e2e mode.
 */
export function installE2EHooks(): void {
	const bridge = getDesktopBridge();
	if (!bridge?.isE2E) return;
	const editor = EditorCore.getInstance();
	(window as unknown as { __e2e: unknown }).__e2e = {
		editor,
		buildElementFromMedia,
		buildTextElement,
		buildGraphicElement,
		buildStickerElement,
		resolveStickerIntrinsicSize,
		buildDefaultMaskInstance,
		mediaTimeFromSeconds,
		/**
		 * Renders the same instant with the editor's renderer and with melt, at full project
		 * size, and reports how far apart the two pictures are.
		 */
		compareWithMlt: async ({ seconds }: { seconds: number }) => {
			const project = editor.project.getActive();
			const { canvasSize, fps, background } = project.settings;
			const { width, height } = canvasSize;
			const time = mediaTimeFromSeconds({ seconds });

			const scene = buildScene({
				tracks: editor.scenes.getActiveScene().tracks,
				mediaAssets: editor.media.getAssets(),
				duration: editor.timeline.getTotalDuration() || 1,
				canvasSize,
				background,
			});
			const editorCanvas = document.createElement("canvas");
			editorCanvas.width = width;
			editorCanvas.height = height;
			await new CanvasRenderer({ width, height, fps }).renderToCanvas({
				node: scene,
				time,
				targetCanvas: editorCanvas,
			});

			const built = await buildMltProject({ editor, bridge });
			const frame = Math.round(
				(time * fps.numerator) / (fps.denominator * MLT_TICKS_PER_SECOND),
			);
			const rendered = await bridge.mlt.previewFrame({ xml: built.xml, frame });
			if (!rendered.ok || !rendered.data) {
				throw new Error(`melt preview failed: ${rendered.error}`);
			}
			const bitmap = await createImageBitmap(
				new Blob([rendered.data as BlobPart], { type: "image/png" }),
			);
			const mltCanvas = document.createElement("canvas");
			mltCanvas.width = width;
			mltCanvas.height = height;
			const mltContext = mltCanvas.getContext("2d");
			const editorContext = editorCanvas.getContext("2d");
			if (!mltContext || !editorContext) throw new Error("no 2d context");
			mltContext.drawImage(bitmap, 0, 0, width, height);

			const a = editorContext.getImageData(0, 0, width, height).data;
			const b = mltContext.getImageData(0, 0, width, height).data;
			let total = 0;
			let differing = 0;
			for (let i = 0; i < a.length; i += 4) {
				const diff =
					Math.abs(a[i] - b[i]) +
					Math.abs(a[i + 1] - b[i + 1]) +
					Math.abs(a[i + 2] - b[i + 2]);
				total += diff;
				if (diff > 120) differing++;
			}
			const pixels = width * height;
			return {
				meanDiff: total / (pixels * 3),
				differingRatio: differing / pixels,
				warnings: built.warnings,
				editorPng: editorCanvas.toDataURL("image/png"),
				mltPng: mltCanvas.toDataURL("image/png"),
			};
		},
		buildMltProject: () => buildMltProject({ editor, bridge }),
		saveProjectFile: async () => {
			await editor.project.saveCurrentProject();
			return saveProjectFile({ editor, bridge });
		},
		/** Runs an export with the same option plumbing as the export panel, minus the dialog. */
		exportWith: ({
			presetId,
			resolutionId = "project",
			quality = "medium",
			includeAudio = true,
			outputPath,
			cancelAfterMs,
		}: {
			presetId: string;
			resolutionId?: MltResolutionId;
			quality?: MltQuality;
			includeAudio?: boolean;
			outputPath: string;
			cancelAfterMs?: number;
		}) => {
			const preset = MLT_EXPORT_PRESETS.find((p) => p.id === presetId);
			if (!preset) throw new Error(`Unknown preset ${presetId}`);
			const handle = startMltExport({
				editor,
				outputPath,
				outputSize: resolveOutputSize({
					canvasSize: editor.project.getActive().settings.canvasSize,
					resolutionId,
				}),
				properties: buildConsumerProperties({ preset, quality, includeAudio }),
				onProgress: () => {},
			});
			if (cancelAfterMs !== undefined) setTimeout(handle.cancel, cancelAfterMs);
			return handle.done;
		},
	};
}

"use client";

import { useEffect, useRef, useState } from "react";
import { getDesktopBridge } from "@/desktop/bridge";
import { useEditor } from "@/editor/use-editor";
import { MLT_TICKS_PER_SECOND } from "@/mlt/convert";
import { buildMltProject } from "@/mlt/export";
import { useMltPreviewStore } from "@/mlt/preview-store";
import { cn } from "@/utils/ui";

// Preview frames are rendered small: melt starts a process per frame, and size is most of the cost.
const PREVIEW_MAX_HEIGHT = 540;
const DEBOUNCE_MS = 180;

export function previewOutputSize({
	canvasSize,
}: {
	canvasSize: { width: number; height: number };
}): { width: number; height: number } {
	const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
	const height = Math.min(canvasSize.height, PREVIEW_MAX_HEIGHT);
	return {
		width: even((canvasSize.width * height) / canvasSize.height),
		height: even(height),
	};
}

type FrameState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "failed"; error: string };

/**
 * Covers the editor's canvas with the frame melt renders for the playhead. It refreshes
 * while paused; during playback it steps aside so the real-time preview shows through.
 */
export function MltPreviewOverlay({
	rect,
}: {
	rect: { left: number; top: number; width: number; height: number };
}) {
	const editor = useEditor();
	const isEnabled = useMltPreviewStore((state) => state.isEnabled);
	const clip = useMltPreviewStore((state) => state.clip);
	const isPlaying = useEditor((e) => e.playback.getIsPlaying());
	const [frameUrl, setFrameUrl] = useState<string | null>(null);
	const [frameState, setFrameState] = useState<FrameState>({ kind: "idle" });
	const frameUrlRef = useRef<string | null>(null);

	useEffect(() => {
		const bridge = getDesktopBridge();
		if (!isEnabled || !bridge || isPlaying) return;

		let disposed = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let requestId = 0;

		const renderFrame = async () => {
			const id = ++requestId;
			setFrameState({ kind: "loading" });
			try {
				const project = editor.project.getActive();
				const { fps, canvasSize } = project.settings;
				const { xml, totalFrames } = await buildMltProject({
					editor,
					bridge,
					outputSize: previewOutputSize({ canvasSize }),
				});
				const frame = Math.min(
					totalFrames - 1,
					Math.max(
						0,
						Math.round(
							(editor.playback.getCurrentTime() * fps.numerator) /
								(fps.denominator * MLT_TICKS_PER_SECOND),
						),
					),
				);
				const result = await bridge.mlt.previewFrame({ xml, frame });
				if (disposed || id !== requestId || result.superseded) return;
				if (!result.ok || !result.data) {
					setFrameState({
						kind: "failed",
						error: result.error ?? "Preview failed",
					});
					return;
				}
				const url = URL.createObjectURL(
					new Blob([result.data as BlobPart], { type: "image/png" }),
				);
				if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
				frameUrlRef.current = url;
				setFrameUrl(url);
				setFrameState({ kind: "idle" });
			} catch (error) {
				if (disposed || id !== requestId) return;
				setFrameState({
					kind: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};

		const schedule = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(renderFrame, DEBOUNCE_MS);
		};

		schedule();
		const unsubscribers = [
			editor.playback.onSeek(schedule),
			editor.timeline.subscribe(schedule),
			editor.scenes.subscribe(schedule),
			editor.project.subscribe(schedule),
		];
		return () => {
			disposed = true;
			if (timer) clearTimeout(timer);
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, [editor, isEnabled, isPlaying]);

	useEffect(
		() => () => {
			if (frameUrlRef.current) URL.revokeObjectURL(frameUrlRef.current);
		},
		[],
	);

	if (!isEnabled) return null;

	const style = {
		left: rect.left,
		top: rect.top,
		width: rect.width,
		height: rect.height,
	};

	if (clip.kind === "ready") {
		return (
			// biome-ignore lint/a11y/useMediaCaption: preview of the user's own project
			<video
				data-testid="mlt-preview-clip"
				className="absolute bg-black"
				style={style}
				src={clip.url}
				controls
				autoPlay
			/>
		);
	}

	return (
		<div
			data-testid="mlt-preview-overlay"
			data-state={frameState.kind}
			className={cn(
				// No z-index: later siblings (selection handles, guides) must stay on top.
				"pointer-events-none absolute",
				isPlaying && "hidden",
			)}
			style={style}
		>
			{frameUrl && (
				// biome-ignore lint/performance/noImgElement: a blob URL that changes per frame
				<img
					data-testid="mlt-preview-frame"
					src={frameUrl}
					alt="MLT preview"
					// While a newer frame renders, show the real-time canvas underneath instead
					// of a stale MLT frame; it follows scrubbing and dragging immediately.
					className={cn(
						"size-full object-fill",
						frameState.kind === "loading" && "opacity-0",
					)}
					draggable={false}
				/>
			)}
			<div className="absolute top-1.5 left-1.5 flex items-center gap-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[0.65rem] text-white">
				<span>MLT</span>
				{frameState.kind === "loading" && <span className="opacity-70">rendering</span>}
				{clip.kind === "rendering" && (
					<span className="opacity-70">
						clip {Math.round(clip.progress * 100)}%
					</span>
				)}
			</div>
			{(frameState.kind === "failed" || clip.kind === "failed") && (
				<div className="absolute inset-x-2 bottom-2 rounded bg-black/80 p-2 text-xs text-white">
					{frameState.kind === "failed"
						? frameState.error
						: clip.kind === "failed"
							? clip.error
							: null}
				</div>
			)}
		</div>
	);
}

"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { getDesktopBridge } from "@/desktop/bridge";
import { useEditor } from "@/editor/use-editor";
import { buildMltProject } from "@/mlt/export";
import { useMltPreviewStore } from "@/mlt/preview-store";
import { previewOutputSize } from "./mlt-preview-overlay";

let clipCounter = 0;

/** Toolbar controls for the MLT preview. Renders nothing outside the desktop shell. */
export function MltPreviewControls() {
	const editor = useEditor();
	const { isEnabled, clip, setEnabled, setClip } = useMltPreviewStore();
	const bridge = getDesktopBridge();

	// A rendered clip shows the timeline as it was; any edit makes it stale.
	useEffect(() => {
		const invalidate = () => {
			const current = useMltPreviewStore.getState().clip;
			if (current.kind === "ready" || current.kind === "failed") {
				useMltPreviewStore.getState().setClip({ kind: "none" });
			}
		};
		const unsubscribers = [
			editor.timeline.subscribe(invalidate),
			editor.scenes.subscribe(invalidate),
		];
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}, [editor]);

	if (!bridge) return null;

	const renderClip = async () => {
		const jobId = `preview-${Date.now()}-${++clipCounter}`;
		setClip({ kind: "rendering", jobId, progress: 0 });
		const unsubscribe = bridge.mlt.onProgress((payload) => {
			if (payload.jobId !== jobId) return;
			const current = useMltPreviewStore.getState().clip;
			if (current.kind === "rendering" && current.jobId === jobId) {
				setClip({ kind: "rendering", jobId, progress: payload.progress });
			}
		});
		try {
			editor.playback.pause();
			const { xml } = await buildMltProject({
				editor,
				bridge,
				outputSize: previewOutputSize({
					canvasSize: editor.project.getActive().settings.canvasSize,
				}),
			});
			const result = await bridge.mlt.previewClip({ jobId, xml });
			const current = useMltPreviewStore.getState().clip;
			if (current.kind !== "rendering" || current.jobId !== jobId) return;
			if (result.cancelled) {
				setClip({ kind: "none" });
			} else if (result.ok && result.data) {
				setClip({
					kind: "ready",
					url: URL.createObjectURL(
						new Blob([result.data as BlobPart], { type: "video/mp4" }),
					),
				});
			} else {
				setClip({ kind: "failed", error: result.error ?? "Preview failed" });
			}
		} catch (error) {
			setClip({
				kind: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			unsubscribe();
		}
	};

	const stopClip = () => {
		if (clip.kind === "rendering") void bridge.mlt.cancel(clip.jobId);
		setClip({ kind: "none" });
	};

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						data-testid="mlt-preview-toggle"
						variant={isEnabled ? "secondary" : "text"}
						size="sm"
						className="h-7 px-2 text-xs"
						onClick={() => {
							if (isEnabled) stopClip();
							setEnabled(!isEnabled);
						}}
					>
						MLT
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					Show the frame exactly as the MLT engine exports it
				</TooltipContent>
			</Tooltip>
			{isEnabled && (
				<Button
					data-testid="mlt-preview-clip-button"
					variant="text"
					size="sm"
					className="h-7 px-2 text-xs"
					onClick={clip.kind === "none" || clip.kind === "failed" ? renderClip : stopClip}
				>
					{clip.kind === "rendering"
						? "Cancel"
						: clip.kind === "ready"
							? "Close clip"
							: "Render clip"}
				</Button>
			)}
			<Separator orientation="vertical" className="h-4" />
		</>
	);
}

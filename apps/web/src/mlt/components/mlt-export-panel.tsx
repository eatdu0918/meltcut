"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { getDesktopBridge, type MltStatus } from "@/desktop/bridge";
import { useEditor } from "@/editor/use-editor";
import { startMltExport, type MltExportHandle } from "@/mlt/export";
import {
	MLT_EXPORT_PRESETS,
	MLT_RESOLUTIONS,
	buildConsumerProperties,
	resolveOutputSize,
	type MltQuality,
	type MltResolutionId,
} from "@/mlt/presets";

const QUALITY_OPTIONS: { value: MltQuality; label: string }[] = [
	{ value: "low", label: "Low - smallest file" },
	{ value: "medium", label: "Medium - balanced" },
	{ value: "high", label: "High - recommended" },
	{ value: "very_high", label: "Very high - largest file" },
];

type Phase =
	| { kind: "idle" }
	| { kind: "exporting"; progress: number }
	| { kind: "done"; outputPath: string; warnings: string[] }
	| { kind: "failed"; error: string };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label className="text-muted-foreground text-xs">{label}</Label>
			{children}
		</div>
	);
}

export function MltExportPanel() {
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const bridge = getDesktopBridge();

	const [status, setStatus] = useState<MltStatus | null>(null);
	const [presetId, setPresetId] = useState(MLT_EXPORT_PRESETS[0].id);
	const [resolutionId, setResolutionId] = useState<MltResolutionId>("project");
	const [quality, setQuality] = useState<MltQuality>("high");
	const [includeAudio, setIncludeAudio] = useState(true);
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const handleRef = useRef<MltExportHandle | null>(null);

	useEffect(() => {
		let ignore = false;
		void bridge?.mlt.status().then((next) => {
			if (!ignore) setStatus(next);
		});
		return () => {
			ignore = true;
			// Closing the popover abandons a running render.
			handleRef.current?.cancel();
		};
	}, [bridge]);

	if (!bridge) return null;

	const preset =
		MLT_EXPORT_PRESETS.find((candidate) => candidate.id === presetId) ??
		MLT_EXPORT_PRESETS[0];

	const handleExport = async () => {
		const outputPath = await bridge.saveDialog({
			defaultName: `${activeProject.metadata.name}${preset.extension}`,
			extension: preset.extension,
		});
		if (!outputPath) return;

		setPhase({ kind: "exporting", progress: 0 });
		const handle = startMltExport({
			editor,
			outputPath,
			outputSize: resolveOutputSize({
				canvasSize: activeProject.settings.canvasSize,
				resolutionId,
			}),
			properties: buildConsumerProperties({ preset, quality, includeAudio }),
			onProgress: (progress) => setPhase({ kind: "exporting", progress }),
		});
		handleRef.current = handle;
		const result = await handle.done;
		handleRef.current = null;

		if (result.cancelled) {
			setPhase({ kind: "idle" });
		} else if (result.ok && result.outputPath) {
			setPhase({
				kind: "done",
				outputPath: result.outputPath,
				warnings: result.warnings,
			});
		} else {
			setPhase({ kind: "failed", error: result.error ?? "Unknown error" });
		}
	};

	if (status && !status.available) {
		return (
			<div className="flex flex-col gap-3 p-3" data-testid="mlt-missing">
				<p className="text-sm font-medium">MLT engine not found</p>
				<p className="text-muted-foreground text-xs">
					Install Shotcut or Kdenlive, then select the folder that contains
					melt.
				</p>
				{status.error && (
					<p className="text-destructive text-xs">{status.error}</p>
				)}
				<Button
					variant="outline"
					onClick={async () => setStatus(await bridge.mlt.chooseBinDir())}
				>
					<FolderOpen className="size-4" />
					Locate MLT
				</Button>
			</div>
		);
	}

	if (phase.kind === "exporting") {
		return (
			<div className="space-y-4 p-3" data-testid="mlt-exporting">
				<div className="flex items-center justify-between">
					<p className="text-muted-foreground text-sm">
						{Math.round(phase.progress * 100)}%
					</p>
					<p className="text-muted-foreground text-sm">100%</p>
				</div>
				<Progress value={phase.progress * 100} className="w-full" />
				<Button
					variant="outline"
					className="w-full rounded-md"
					onClick={() => handleRef.current?.cancel()}
				>
					Cancel
				</Button>
			</div>
		);
	}

	if (phase.kind === "done") {
		return (
			<div className="flex flex-col gap-3 p-3" data-testid="mlt-done">
				<p className="text-sm font-medium">Export finished</p>
				<p className="text-muted-foreground text-xs break-all">
					{phase.outputPath}
				</p>
				{phase.warnings.length > 0 && (
					<div className="flex flex-col gap-1">
						<p className="text-xs font-medium">
							Not included in this export:
						</p>
						<ul className="text-muted-foreground max-h-24 list-disc overflow-y-auto pl-4 text-xs">
							{phase.warnings.map((warning) => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					</div>
				)}
				<div className="flex gap-2">
					<Button
						variant="outline"
						className="flex-1"
						onClick={() => bridge.showItemInFolder(phase.outputPath)}
					>
						<FolderOpen className="size-4" />
						Show in folder
					</Button>
					<Button className="flex-1" onClick={() => setPhase({ kind: "idle" })}>
						Done
					</Button>
				</div>
			</div>
		);
	}

	if (phase.kind === "failed") {
		return (
			<div className="flex flex-col gap-3 p-3" data-testid="mlt-failed">
				<p className="text-destructive text-sm font-medium">Export failed</p>
				<p className="text-muted-foreground max-h-32 overflow-y-auto text-xs whitespace-pre-wrap">
					{phase.error}
				</p>
				<Button variant="outline" onClick={() => setPhase({ kind: "idle" })}>
					Back
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3 p-3" data-testid="mlt-export-panel">
			<Field label="Format">
				<Select value={presetId} onValueChange={setPresetId}>
					<SelectTrigger className="w-full" data-testid="mlt-preset">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{MLT_EXPORT_PRESETS.map((option) => (
							<SelectItem key={option.id} value={option.id}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<p className="text-muted-foreground text-xs">{preset.description}</p>
			</Field>

			{preset.hasVideo && (
				<Field label="Resolution">
					<Select
						value={resolutionId}
						onValueChange={(value) => setResolutionId(value as MltResolutionId)}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{MLT_RESOLUTIONS.map((option) => (
								<SelectItem key={option.id} value={option.id}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
			)}

			<Field label="Quality">
				<Select
					value={quality}
					onValueChange={(value) => setQuality(value as MltQuality)}
				>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{QUALITY_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</Field>

			{preset.hasVideo && preset.hasAudio && (
				<div className="flex items-center space-x-2">
					<Checkbox
						id="mlt-include-audio"
						checked={includeAudio}
						onCheckedChange={(checked) => setIncludeAudio(!!checked)}
					/>
					<Label htmlFor="mlt-include-audio">Include audio</Label>
				</div>
			)}

			<Button onClick={handleExport} className="w-full gap-2" data-testid="mlt-export-start">
				<Download className="size-4" />
				Export
			</Button>
			{status?.version && (
				<p className="text-muted-foreground text-center text-[0.7rem]">
					MLT {status.version}
				</p>
			)}
		</div>
	);
}

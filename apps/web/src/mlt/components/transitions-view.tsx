"use client";

import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { getDesktopBridge } from "@/desktop/bridge";
import { useEditor } from "@/editor/use-editor";
import {
	DEFAULT_TRANSITION_SECONDS,
	MLT_TRANSITIONS,
	readTransitions,
	TRANSITION_PARAMS,
	type ClipTransition,
} from "@/mlt/transitions";
import type { ParamValues } from "@/params";
import type { TimelineElement } from "@/timeline/types";

const NONE = "none";
const AUDIO_ONLY_TRANSITIONS = ["fade"];

function Note({ children }: { children: React.ReactNode }) {
	return <p className="text-muted-foreground text-sm">{children}</p>;
}

function TransitionEditor({
	title,
	hint,
	testId,
	transition,
	allowedIds,
	onChange,
}: {
	title: string;
	hint: string;
	testId: string;
	transition: ClipTransition | null;
	allowedIds: readonly string[] | null;
	onChange: (next: { type: string | null; seconds: number }) => void;
}) {
	const seconds = transition?.seconds ?? DEFAULT_TRANSITION_SECONDS;
	const options = MLT_TRANSITIONS.filter(
		(option) => !allowedIds || allowedIds.includes(option.id),
	);
	return (
		<div className="flex flex-col gap-2 rounded-md border p-3">
			<div className="flex flex-col gap-0.5">
				<Label className="text-sm font-medium">{title}</Label>
				<span className="text-muted-foreground text-xs">{hint}</span>
			</div>
			<Select
				value={transition?.type ?? NONE}
				onValueChange={(value) =>
					onChange({ type: value === NONE ? null : value, seconds })
				}
			>
				<SelectTrigger className="w-full" data-testid={`${testId}-type`}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={NONE}>None</SelectItem>
					{options.map((option) => (
						<SelectItem key={option.id} value={option.id}>
							{option.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{transition && (
				<div className="flex items-center gap-3">
					<Slider
						className="flex-1"
						min={0.1}
						max={3}
						step={0.1}
						value={[Math.min(3, seconds)]}
						onValueChange={([value]) =>
							onChange({ type: transition.type, seconds: value })
						}
					/>
					<span className="text-muted-foreground w-10 text-right text-xs tabular-nums">
						{seconds.toFixed(1)}s
					</span>
				</div>
			)}
		</div>
	);
}

/**
 * The Transitions tab. A transition is set on the selected clips' own start or end and is
 * rendered by the MLT engine, so it shows in the MLT preview and in MLT exports.
 */
export function TransitionsView() {
	const editor = useEditor();
	const selected = useEditor((e) => e.selection.getSelectedElements());
	// Subscribes to timeline changes so the controls follow undo and redo.
	const tracks = useEditor((e) => e.scenes.getActiveSceneOrNull()?.tracks);

	if (!getDesktopBridge()) {
		return (
			<PanelView title="Transitions">
				<Note>Transitions are rendered by the MLT engine in the desktop app.</Note>
			</PanelView>
		);
	}

	const elements: TimelineElement[] = [];
	if (tracks) {
		for (const track of [tracks.main, ...tracks.overlay, ...tracks.audio]) {
			for (const element of track.elements) {
				if (
					selected.some(
						(ref) => ref.trackId === track.id && ref.elementId === element.id,
					)
				) {
					elements.push(element);
				}
			}
		}
	}

	if (elements.length === 0) {
		return (
			<PanelView title="Transitions">
				<Note>Select a clip on the timeline to give it a transition.</Note>
			</PanelView>
		);
	}

	// With several clips selected the controls show the first one and apply to all.
	const current = readTransitions({ params: elements[0].params });
	const audioOnly = elements.every((element) => element.type === "audio");

	const apply = ({
		typeKey,
		secondsKey,
		next,
	}: {
		typeKey: string;
		secondsKey: string;
		next: { type: string | null; seconds: number };
	}) => {
		// An empty type clears the transition; `params` holds only plain values.
		const params: Partial<ParamValues> = {
			[typeKey]: next.type ?? "",
			[secondsKey]: next.seconds,
		};
		editor.timeline.updateElements({
			updates: selected.map((ref) => ({
				trackId: ref.trackId,
				elementId: ref.elementId,
				patch: { params } as Partial<TimelineElement>,
			})),
		});
	};

	return (
		<PanelView title="Transitions">
			<div className="flex flex-col gap-3" data-testid="transitions-view">
				<TransitionEditor
					title="In"
					hint="Plays as the clip appears"
					testId="transition-in"
					transition={current.in}
					allowedIds={audioOnly ? AUDIO_ONLY_TRANSITIONS : null}
					onChange={(next) =>
						apply({
							typeKey: TRANSITION_PARAMS.inType,
							secondsKey: TRANSITION_PARAMS.inSeconds,
							next,
						})
					}
				/>
				<TransitionEditor
					title="Out"
					hint="Plays as the clip disappears"
					testId="transition-out"
					transition={current.out}
					allowedIds={audioOnly ? AUDIO_ONLY_TRANSITIONS : null}
					onChange={(next) =>
						apply({
							typeKey: TRANSITION_PARAMS.outType,
							secondsKey: TRANSITION_PARAMS.outSeconds,
							next,
						})
					}
				/>
				<Note>
					Turn on MLT in the preview toolbar to see transitions. Where two clips touch on
					the same track, the transition plays between them: a fade becomes a dissolve from
					one clip to the other.
				</Note>
			</div>
		</PanelView>
	);
}

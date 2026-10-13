import { create } from "zustand";

/**
 * The editor's own preview stays the real-time one. The MLT preview is an optional
 * layer on top that shows exactly what the MLT engine will export.
 */
export type MltPreviewClip =
	| { kind: "none" }
	| { kind: "rendering"; jobId: string; progress: number }
	| { kind: "ready"; url: string }
	| { kind: "failed"; error: string };

interface MltPreviewState {
	isEnabled: boolean;
	clip: MltPreviewClip;
	setEnabled: (isEnabled: boolean) => void;
	setClip: (clip: MltPreviewClip) => void;
}

export const useMltPreviewStore = create<MltPreviewState>((set, get) => ({
	isEnabled: false,
	clip: { kind: "none" },
	setEnabled: (isEnabled) => set({ isEnabled }),
	setClip: (clip) => {
		const previous = get().clip;
		if (previous.kind === "ready" && previous !== clip) {
			URL.revokeObjectURL(previous.url);
		}
		set({ clip });
	},
}));

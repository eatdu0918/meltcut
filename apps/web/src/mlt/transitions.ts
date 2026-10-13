import type { ParamValues } from "@/params";

/**
 * Transitions rendered by the MLT engine. A transition belongs to one clip: it plays as
 * the clip appears ("in") or disappears ("out") and reveals whatever is underneath.
 *
 * For a cross-dissolve between two clips, overlap them on two tracks and fade the upper
 * one. The editor's timeline has no shared cut between clips to attach a transition to,
 * and this needs no spare footage beyond the clip's own length.
 *
 * Stored in the clip's `params`, so it is saved, copied and undone like any other value.
 */
export const TRANSITION_PARAMS = {
	inType: "transition.in.type",
	inSeconds: "transition.in.seconds",
	outType: "transition.out.type",
	outSeconds: "transition.out.seconds",
} as const;

export const MLT_TRANSITIONS = [
	{ id: "fade", name: "Fade" },
	{ id: "slide-left", name: "Slide from left" },
	{ id: "slide-right", name: "Slide from right" },
	{ id: "slide-up", name: "Slide from top" },
	{ id: "slide-down", name: "Slide from bottom" },
	{ id: "zoom-in", name: "Zoom in" },
	{ id: "zoom-out", name: "Zoom out" },
	{ id: "wipe-left", name: "Wipe from left" },
	{ id: "wipe-right", name: "Wipe from right" },
	{ id: "wipe-up", name: "Wipe from top" },
	{ id: "wipe-down", name: "Wipe from bottom" },
] as const;

export type MltTransitionId = (typeof MLT_TRANSITIONS)[number]["id"];

export const DEFAULT_TRANSITION_SECONDS = 0.5;
export const MAX_TRANSITION_SECONDS = 10;

const isTransitionId = (value: unknown): value is MltTransitionId =>
	MLT_TRANSITIONS.some((transition) => transition.id === value);

export interface ClipTransition {
	type: MltTransitionId;
	seconds: number;
}

export function readTransitions({ params }: { params: ParamValues }): {
	in: ClipTransition | null;
	out: ClipTransition | null;
} {
	const read = (typeKey: string, secondsKey: string): ClipTransition | null => {
		const type = params[typeKey];
		if (!isTransitionId(type)) return null;
		const seconds = Number(params[secondsKey]);
		return {
			type,
			seconds:
				Number.isFinite(seconds) && seconds > 0
					? Math.min(seconds, MAX_TRANSITION_SECONDS)
					: DEFAULT_TRANSITION_SECONDS,
		};
	};
	return {
		in: read(TRANSITION_PARAMS.inType, TRANSITION_PARAMS.inSeconds),
		out: read(TRANSITION_PARAMS.outType, TRANSITION_PARAMS.outSeconds),
	};
}

/** How a clip is altered at one instant of a transition. */
export interface TransitionModifiers {
	/** Multiplies the clip's opacity. */
	opacity: number;
	/** Offset of the clip's centre, in fractions of the canvas width and height. */
	offsetX: number;
	offsetY: number;
	/** Multiplies the clip's size. */
	scale: number;
	/** Part of the clip left visible, as fractions of its own frame. */
	reveal: { left: number; top: number; right: number; bottom: number };
	/** Multiplies the clip's audio level (linear gain). */
	gain: number;
}

export const NO_MODIFIERS: TransitionModifiers = {
	opacity: 1,
	offsetX: 0,
	offsetY: 0,
	scale: 1,
	reveal: { left: 0, top: 0, right: 1, bottom: 1 },
	gain: 1,
};

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * Modifiers for a transition that is `progress` of the way to the clip being fully shown
 * (0 = hidden, 1 = fully shown). The same curve runs backwards for an "out" transition.
 */
export function transitionModifiers({
	type,
	progress,
}: {
	type: MltTransitionId;
	progress: number;
}): TransitionModifiers {
	const p = Math.min(1, Math.max(0, progress));
	const hidden = 1 - easeOut(p);
	switch (type) {
		case "fade":
			return { ...NO_MODIFIERS, opacity: p, gain: p };
		case "slide-left":
			return { ...NO_MODIFIERS, offsetX: -hidden };
		case "slide-right":
			return { ...NO_MODIFIERS, offsetX: hidden };
		case "slide-up":
			return { ...NO_MODIFIERS, offsetY: -hidden };
		case "slide-down":
			return { ...NO_MODIFIERS, offsetY: hidden };
		case "zoom-in":
			return { ...NO_MODIFIERS, scale: 1 - 0.7 * hidden, opacity: Math.min(1, p * 2) };
		case "zoom-out":
			return { ...NO_MODIFIERS, scale: 1 + 0.7 * hidden, opacity: Math.min(1, p * 2) };
		case "wipe-left":
			return { ...NO_MODIFIERS, reveal: { left: 0, top: 0, right: p, bottom: 1 } };
		case "wipe-right":
			return { ...NO_MODIFIERS, reveal: { left: 1 - p, top: 0, right: 1, bottom: 1 } };
		case "wipe-up":
			return { ...NO_MODIFIERS, reveal: { left: 0, top: 0, right: 1, bottom: p } };
		case "wipe-down":
			return { ...NO_MODIFIERS, reveal: { left: 0, top: 1 - p, right: 1, bottom: 1 } };
	}
}

function combine(a: TransitionModifiers, b: TransitionModifiers): TransitionModifiers {
	return {
		opacity: a.opacity * b.opacity,
		offsetX: a.offsetX + b.offsetX,
		offsetY: a.offsetY + b.offsetY,
		scale: a.scale * b.scale,
		reveal: {
			left: Math.max(a.reveal.left, b.reveal.left),
			top: Math.max(a.reveal.top, b.reveal.top),
			right: Math.min(a.reveal.right, b.reveal.right),
			bottom: Math.min(a.reveal.bottom, b.reveal.bottom),
		},
		gain: a.gain * b.gain,
	};
}

/**
 * Modifiers for every frame of a clip, or null when it has no transitions. Each transition
 * is limited to half the clip so "in" and "out" never overlap.
 */
export function clipTransitionFrames({
	params,
	length,
	framesPerSecond,
}: {
	params: ParamValues;
	length: number;
	framesPerSecond: number;
}): ((frame: number) => TransitionModifiers) | null {
	const transitions = readTransitions({ params });
	if (!transitions.in && !transitions.out) return null;
	const limit = Math.max(1, Math.floor(length / 2));
	const framesOf = (transition: ClipTransition | null) =>
		transition
			? Math.min(limit, Math.max(1, Math.round(transition.seconds * framesPerSecond)))
			: 0;
	const inFrames = framesOf(transitions.in);
	const outFrames = framesOf(transitions.out);

	return (frame) => {
		let modifiers = NO_MODIFIERS;
		if (transitions.in && frame < inFrames) {
			modifiers = combine(
				modifiers,
				transitionModifiers({ type: transitions.in.type, progress: frame / inFrames }),
			);
		}
		const remaining = length - 1 - frame;
		if (transitions.out && remaining < outFrames) {
			modifiers = combine(
				modifiers,
				transitionModifiers({ type: transitions.out.type, progress: remaining / outFrames }),
			);
		}
		return modifiers;
	};
}

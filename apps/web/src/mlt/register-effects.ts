import { effectsRegistry } from "@/effects/registry";
import type { EffectDefinition } from "@/effects/types";
import { MLT_EFFECTS } from "./effects";

/**
 * Adds the MLT-only effects to the editor's registry so the Effects panel lists them.
 * They have no shader passes: the real-time preview leaves the clip as it is, and the
 * MLT preview and export render the effect.
 */
export function registerMltEffects(): void {
	for (const effect of MLT_EFFECTS) {
		if (effectsRegistry.has(effect.type)) continue;
		const definition: EffectDefinition = {
			type: effect.type,
			name: effect.name,
			keywords: [...effect.keywords, "mlt"],
			params: effect.params,
			renderer: { passes: [], buildPasses: () => [] },
		};
		effectsRegistry.register({ key: effect.type, definition });
	}
}

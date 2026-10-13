import { describe, expect, test } from "bun:test";
import { convertToMlt, type MltMediaSource } from "../convert";
import fixture from "./fixture-project.json";

// A real project saved by the editor: clipA on main, clipB cut at frame 61 on an overlay, one text.
const scene = fixture.scenes[0] as unknown as Parameters<
	typeof convertToMlt
>[0]["scene"];
const settings = fixture.settings as unknown as Parameters<
	typeof convertToMlt
>[0]["settings"];
const media = new Map<string, MltMediaSource>([
	["29a2c091-5533-478d-9192-f5b473e6af31", { path: String.raw`C:\media\clipB.mp4`, width: 1280, height: 720 }],
	["dc27e7c9-6bed-4417-bb5a-32962b96c0e6", { path: String.raw`C:\media\clipA.mp4`, width: 1280, height: 720 }],
]);

const convert = (overrides: Partial<Parameters<typeof convertToMlt>[0]> = {}) =>
	convertToMlt({ projectName: "Test", settings, scene, media, ...overrides });

describe("convertToMlt", () => {
	test("timeline length and profile follow the project", () => {
		const { xml, totalFrames, warnings } = convert();
		expect(totalFrames).toBe(300);
		expect(warnings).toEqual([]);
		expect(xml).toContain('width="1280" height="720"');
		expect(xml).toContain('frame_rate_num="30" frame_rate_den="1"');
		expect(xml).toContain('<tractor id="main_tractor" in="0" out="299">');
	});

	test("cut clip keeps frame-exact in/out and paths use forward slashes", () => {
		const { xml } = convert();
		// clipB (left part): 244000 ticks = 61 frames -> out frame 60
		const clipB = /<producer id="(producer\d+)">\s*<property name="resource">C:\/media\/clipB.mp4/.exec(xml)?.[1];
		expect(xml).toContain(`<entry producer="${clipB}" in="0" out="60"/>`);
		expect(xml).toMatch(/<producer id="producer0">\s*<property name="resource">C:\/media\/clipA.mp4/);
		expect(xml).toContain('<entry producer="producer0" in="0" out="299"/>');
	});

	test("tracks stack bottom to top: main, overlay video, text", () => {
		const { xml } = convert();
		const order = [...xml.matchAll(/<track producer="(\w+)"/g)].map((m) => m[1]);
		expect(order).toEqual(["background_track", "playlist0", "playlist1", "playlist2"]);
		// text starts at 336000 ticks = frame 84 and lasts 150 frames
		expect(xml).toContain('<blank length="84"/>');
		expect(xml).toMatch(/dynamictext.*Default text.*<property name="size">120</s);
	});

	test("missing media is skipped with a warning instead of failing", () => {
		const { xml, warnings } = convert({ media: new Map() });
		expect(xml).not.toContain("clipA.mp4");
		expect(warnings.filter((w) => w.includes("source file is missing"))).toHaveLength(2);
	});

	test("transform becomes a qtblend rect around the canvas centre", () => {
		const moved = structuredClone(scene);
		Object.assign(moved.tracks.main.elements[0].params, {
			"transform.positionX": 100,
			"transform.positionY": -50,
			"transform.scaleX": 0.5,
			"transform.scaleY": 0.5,
			"transform.rotate": 30,
			opacity: 0.8,
		});
		const { xml } = convert({ scene: moved });
		// 640x360 box centred at (740, 310)
		expect(xml).toContain('<property name="rect">420 130 640 360 0.8</property>');
		expect(xml).toContain('<property name="rotation">30</property>');
	});

	test("text with XML-special characters and # is escaped", () => {
		const edited = structuredClone(scene);
		const text = edited.tracks.overlay[0].elements[0];
		text.params.content = 'a <b> & "c" #1';
		const { xml } = convert({ scene: edited });
		expect(xml).toContain(String.raw`a &lt;b&gt; &amp; &quot;c&quot; \#1`);
	});
});

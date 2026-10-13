// Shared steps for e2e scripts. Everything goes through the real UI unless noted.
const path = require("node:path");

const TEST_MEDIA_DIR =
	process.env.E2E_MEDIA_DIR ?? path.resolve(__dirname, "..", "..", "..", "..", "test-media");
const OUT_DIR = path.join(__dirname, "out");

const clickByText = (text) => `
	const el = [...document.querySelectorAll("button, [role=menuitem], a")]
		.find((node) => node.textContent.trim().includes(${JSON.stringify(text)}));
	if (!el) return false;
	el.click();
	return true;
`;

/** Reads every row of an object store in one of the app's IndexedDB databases. */
const readStore = (dbName, storeName) => `
	return await new Promise((resolve, reject) => {
		const open = indexedDB.open(${JSON.stringify(dbName)});
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const request = open.result.transaction(${JSON.stringify(storeName)}).objectStore(${JSON.stringify(storeName)}).getAll();
			request.onerror = () => reject(request.error);
			request.onsuccess = () => resolve(request.result);
		};
	});
`;

async function createProject(ctx) {
	await ctx.waitFor(`document.body.innerText.includes("project")`, { label: "projects page" });
	// The page is server-rendered first; keep clicking until React has hydrated and reacts.
	const deadline = Date.now() + 60_000;
	while (!(await ctx.exec(`return location.pathname.startsWith("/editor/")`))) {
		if (Date.now() > deadline) throw new Error("Timed out creating a project");
		(await ctx.exec(clickByText("Create your first project"))) ||
			(await ctx.exec(clickByText("New project")));
		await ctx.sleep(1000);
	}
	await ctx.waitFor(`document.querySelector("input[type=file]")`, { label: "editor ready" });
	// Dismiss the first-run onboarding dialog if it shows up.
	await ctx.sleep(500);
	await ctx.exec(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
	await ctx.exec(`localStorage.setItem("hasSeenOnboarding", "true")`);
	return ctx.exec(`return location.pathname.split("/").pop()`);
}

async function importMedia(ctx, names) {
	const projectId = await ctx.exec(`return location.pathname.split("/").pop()`);
	const countRows = `(async () => { ${readStore(`video-editor-media-${projectId}`, "media-metadata")} })().then((rows) => rows.length).catch(() => 0)`;
	const files = names.map((name) => path.join(TEST_MEDIA_DIR, name));
	// The import input takes one file per pick, so add them one at a time like a user would.
	for (const file of files) {
		const before = await ctx.exec(`return ${countRows}`);
		await ctx.setInputFiles("input[type=file]", [file]);
		await ctx.waitFor(`${countRows}.then((count) => count > ${before})`, { label: `import ${path.basename(file)}` });
	}
	return files;
}

/** clipA on main for 10s, clipB on an overlay cut down to its first 2s. */
const buildTimeline = `
	const { editor, buildElementFromMedia, mediaTimeFromSeconds } = window.__e2e;
	const assets = editor.media.getAssets();
	for (const name of ["clipA.mp4", "clipB.mp4"]) {
		const asset = assets.find((a) => a.name === name);
		editor.timeline.insertElement({
			element: buildElementFromMedia({
				mediaId: asset.id,
				mediaType: asset.type,
				name: asset.name,
				duration: mediaTimeFromSeconds({ seconds: asset.duration }),
				startTime: mediaTimeFromSeconds({ seconds: 0 }),
			}),
			placement: { mode: "auto" },
		});
	}
	const tracks = editor.scenes.getActiveScene().tracks;
	const overlay = tracks.overlay.find((t) => t.elements.some((e) => e.name === "clipB.mp4"));
	if (!overlay) throw new Error("clipB did not land on an overlay track: " + JSON.stringify(tracks));
	editor.timeline.splitElements({
		elements: [{ trackId: overlay.id, elementId: overlay.elements[0].id }],
		splitTime: mediaTimeFromSeconds({ seconds: 2 }),
		retainSide: "left",
	});
	return true;
`;

function assert(condition, message) {
	if (!condition) throw new Error(`Assertion failed: ${message}`);
}

module.exports = { buildTimeline, TEST_MEDIA_DIR, OUT_DIR, clickByText, createProject, importMedia, readStore, assert };

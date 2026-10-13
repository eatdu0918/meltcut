import type { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import type { MediaAsset, MediaType } from "@/media/types";
import type { TProject } from "@/project/types";
import { storageService } from "@/services/storage/service";
import type { TScene } from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import type { DesktopBridge } from "./bridge";

/**
 * A project as one file on disk. The editor itself keeps projects in browser storage,
 * which cannot be backed up, moved to another computer, or handed to someone else.
 *
 * The file holds the timeline and a list of the media it uses by path; the media files
 * themselves stay where they are.
 */
export const PROJECT_FILE_EXTENSION = ".meltcut";
const FORMAT = "meltcut-project";
const VERSION = 1;

interface ProjectFileMedia {
	id: string;
	name: string;
	type: MediaType;
	filePath: string;
}

interface ProjectFile {
	format: typeof FORMAT;
	version: number;
	savedAt: string;
	project: unknown;
	media: ProjectFileMedia[];
}

const extensionOf = (name: string, type: MediaType): string =>
	/\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ??
	(type === "image" ? ".png" : type === "audio" ? ".wav" : ".mp4");

const MIME_BY_EXTENSION: Record<string, string> = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".flac": "audio/flac",
	".ogg": "audio/ogg",
	".opus": "audio/ogg",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".avif": "image/avif",
};

/** Writes the open project to a file the user picks. Returns the path, or null if cancelled. */
export async function saveProjectFile({
	editor,
	bridge,
}: {
	editor: EditorCore;
	bridge: DesktopBridge;
}): Promise<string | null> {
	const active = editor.project.getActive();
	const filePath = await bridge.saveDialog({
		defaultName: `${active.metadata.name}${PROJECT_FILE_EXTENSION}`,
		extension: PROJECT_FILE_EXTENSION,
	});
	if (!filePath) return null;

	const media: ProjectFileMedia[] = [];
	for (const asset of editor.media.getAssets()) {
		if (asset.ephemeral) continue;
		let path = asset.filePath;
		if (!path || !(await bridge.fileExists(path))) {
			// No original on disk (pasted, or it was moved): keep a copy next to the app's data
			// so the project file still has something to point at.
			path = await bridge.cacheMedia({
				id: asset.id,
				extension: extensionOf(asset.name, asset.type),
				data: await asset.file.arrayBuffer(),
			});
		}
		media.push({ id: asset.id, name: asset.name, type: asset.type, filePath: path });
	}

	const { thumbnail: _thumbnail, ...metadata } = active.metadata;
	const file: ProjectFile = {
		format: FORMAT,
		version: VERSION,
		savedAt: new Date().toISOString(),
		project: { ...active, metadata, scenes: editor.scenes.getScenes() },
		media,
	};
	await bridge.writeTextFile({ filePath, text: JSON.stringify(file, null, "\t") });
	return filePath;
}

function parseProjectFile(text: string): ProjectFile {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new Error("This is not a project file.");
	}
	const file = data as Partial<ProjectFile>;
	if (file?.format !== FORMAT || typeof file.project !== "object" || !Array.isArray(file.media)) {
		throw new Error("This is not a project file.");
	}
	if (typeof file.version !== "number" || file.version > VERSION) {
		throw new Error("This project file was made by a newer version of the app.");
	}
	return file as ProjectFile;
}

export interface OpenedProjectFile {
	projectId: string;
	/** Names of media files that could not be found at their saved path. */
	missingMedia: string[];
}

/**
 * Opens a project file as a new project and returns its id, or null if cancelled. The
 * project gets a fresh id, so opening the same file twice never overwrites earlier work.
 */
export async function openProjectFile({
	bridge,
}: {
	bridge: DesktopBridge;
}): Promise<OpenedProjectFile | null> {
	const filePath = await bridge.openDialog({
		name: "Project",
		extension: PROJECT_FILE_EXTENSION,
	});
	if (!filePath) return null;

	const file = parseProjectFile(await bridge.readTextFile(filePath));
	const source = file.project as TProject & {
		metadata: { createdAt: string | Date; updatedAt: string | Date };
		scenes: Array<TScene & { createdAt: string | Date; updatedAt: string | Date }>;
	};
	if (!source.metadata || !Array.isArray(source.scenes) || !source.settings) {
		throw new Error("This project file is incomplete.");
	}

	const projectId = generateUUID();
	const now = new Date();
	const project: TProject = {
		...source,
		metadata: {
			...source.metadata,
			id: projectId,
			createdAt: new Date(source.metadata.createdAt),
			updatedAt: now,
		},
		scenes: source.scenes.map((scene) => ({
			...scene,
			createdAt: new Date(scene.createdAt),
			updatedAt: new Date(scene.updatedAt),
		})),
	};

	const missingMedia: string[] = [];
	for (const entry of file.media) {
		if (
			typeof entry?.id !== "string" ||
			typeof entry.filePath !== "string" ||
			!(await bridge.fileExists(entry.filePath))
		) {
			missingMedia.push(String(entry?.name ?? entry?.filePath ?? "unknown"));
			continue;
		}
		const bytes = await bridge.readMediaFile(entry.filePath);
		const extension = extensionOf(entry.name, entry.type).toLowerCase();
		const blob = new File([bytes as BlobPart], entry.name, {
			type: MIME_BY_EXTENSION[extension] ?? "",
		});
		const [processed] = await processMediaAssets({ files: [blob] });
		if (!processed) {
			missingMedia.push(entry.name);
			continue;
		}
		const asset: MediaAsset = { ...processed, id: entry.id, filePath: entry.filePath };
		await storageService.saveMediaAsset({ projectId, mediaAsset: asset });
		if (processed.url) URL.revokeObjectURL(processed.url);
	}

	await storageService.saveProject({ project });
	return { projectId, missingMedia };
}

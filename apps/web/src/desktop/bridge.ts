/**
 * Typed access to the API the Electron shell exposes on `window.desktop`
 * (see apps/shell/src/preload.cjs). Returns null when running in a plain browser.
 */
export interface MltStatus {
	available: boolean;
	binDir: string | null;
	version: string | null;
	error?: string;
}

export interface MltRenderResult {
	ok: boolean;
	cancelled?: boolean;
	error?: string;
	outputPath?: string;
	size?: number;
	/** Tail of melt's own messages, for diagnosing a failed render. */
	log?: string;
}

export interface DesktopBridge {
	isDesktop: true;
	/** True only when the shell runs an automated e2e script. */
	isE2E: boolean;
	getPathForFile: (file: File) => string;
	fileExists: (filePath: string) => Promise<boolean>;
	saveDialog: (options: {
		defaultName: string;
		extension: string;
	}) => Promise<string | null>;
	openDialog: (options: {
		name: string;
		extension: string;
	}) => Promise<string | null>;
	writeTextFile: (request: { filePath: string; text: string }) => Promise<void>;
	readTextFile: (filePath: string) => Promise<string>;
	/** Bytes of a media file a project refers to. Other file types are refused. */
	readMediaFile: (filePath: string) => Promise<Uint8Array>;
	showItemInFolder: (filePath: string) => Promise<void>;
	cacheMedia: (request: {
		id: string;
		extension: string;
		data: ArrayBuffer;
	}) => Promise<string>;
	mlt: {
		status: () => Promise<MltStatus>;
		/** Channels of a file's first audio stream; null when it has none. */
		audioChannels: (filePath: string) => Promise<number | null>;
		chooseBinDir: () => Promise<MltStatus>;
		render: (request: {
			jobId: string;
			xml: string;
			outputPath: string;
			properties: Record<string, string | number>;
		}) => Promise<MltRenderResult>;
		/** One frame of the project as PNG bytes. A newer request supersedes a running one. */
		previewFrame: (request: { xml: string; frame: number }) => Promise<{
			ok: boolean;
			superseded?: boolean;
			error?: string;
			data?: Uint8Array;
		}>;
		/** The whole project as a small MP4, for real-time playback of the MLT result. */
		previewClip: (request: { jobId: string; xml: string }) => Promise<{
			ok: boolean;
			cancelled?: boolean;
			error?: string;
			data?: Uint8Array;
		}>;
		cancel: (jobId: string) => Promise<boolean>;
		onProgress: (
			listener: (payload: { jobId: string; progress: number }) => void,
		) => () => void;
	};
}

export function getDesktopBridge(): DesktopBridge | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { desktop?: DesktopBridge }).desktop ?? null;
}

/** On-disk path of a user-picked file, or undefined when there is none (browser, pasted blobs). */
export function getFilePath({ file }: { file: File }): string | undefined {
	const path = getDesktopBridge()?.getPathForFile(file);
	return path ? path : undefined;
}

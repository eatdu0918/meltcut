import type { Metadata } from "next";
import { SITE_INFO } from "@/site/brand";

export const baseMetaData: Metadata = {
	title: SITE_INFO.title,
	description: SITE_INFO.description,
	icons: {
		icon: [
			{ url: SITE_INFO.favicon },
			{ url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
			{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
		],
		shortcut: [SITE_INFO.favicon],
	},
	manifest: "/manifest.json",
};

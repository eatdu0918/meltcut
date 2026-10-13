import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	reactStrictMode: true,
	// The desktop installer ships this self-contained server instead of the whole repo.
	output: "standalone",
	outputFileTracingRoot: path.join(__dirname, "..", ".."),
	images: {
		remotePatterns: [
			{ protocol: "https", hostname: "api.iconify.design" },
			{ protocol: "https", hostname: "api.simplesvg.com" },
			{ protocol: "https", hostname: "api.unisvg.com" },
		],
	},
};

export default nextConfig;

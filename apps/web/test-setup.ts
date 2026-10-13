import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * `opencut-wasm` is built for bundlers: it imports its .wasm file as a module, which Bun's
 * test runner does not instantiate. This loads the same file by hand so code that touches
 * the wasm (time maths, placement) can run under `bun test`.
 */
const require = createRequire(import.meta.url);
const bindingsPath = require.resolve("opencut-wasm/opencut_wasm_bg.js");
const bindings = await import(bindingsPath);
const { instance } = await WebAssembly.instantiate(
	readFileSync(bindingsPath.replace(/\.js$/, ".wasm")),
	{ "./opencut_wasm_bg.js": bindings },
);
bindings.__wbg_set_wasm(instance.exports);
(instance.exports.__wbindgen_start as (() => void) | undefined)?.();
mock.module("opencut-wasm", () => bindings);

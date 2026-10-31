/**
 * Odin syntax highlighting.
 *
 * pi bundles highlight.js and ships a fixed language set, so no extension API
 * can register a grammar. This extension reaches pi's own highlight.js instance
 * instead: the bundled chunk that owns the shared core can be imported by
 * absolute path, and importing it returns the same module instance pi is using,
 * so the grammar takes effect immediately.
 *
 * Colors code blocks tagged `odin` in the TUI: assistant messages and
 * code-block-box. Two places stay unhighlighted because they own separate
 * lookup tables or highlight.js copies that an extension cannot reach: `.odin`
 * file paths (pi's `getLanguageFromPath()` table) and exported HTML (the
 * browser-side `vendor/highlight.min.js`).
 *
 * The grammar is vendored in `odin-grammar.cjs` from the highlightjs-odinlang
 * package (MIT, Ginger Bill).
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const requireFromHere = createRequire(import.meta.url);

const PI_PACKAGE_NAMES = new Set(["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]);

function realpathOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** Walk up from a file or directory until a package.json names pi. */
function findPiPackageDir(start: string): string | undefined {
	let dir = start;
	for (;;) {
		const packageJson = join(dir, "package.json");
		if (existsSync(packageJson)) {
			try {
				if (PI_PACKAGE_NAMES.has(JSON.parse(readFileSync(packageJson, "utf8")).name)) {
					return dir;
				}
			} catch {
				// Unreadable or malformed package.json: keep walking up.
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Locate pi's install directory. `process.argv[1]` is the entry script, but it
 * is often the `/opt/homebrew/bin/pi` symlink, so resolve links before walking
 * up. PATH entries are a fallback for launchers that proxy pi.
 */
function resolvePiPackageDir(): string | undefined {
	const starts: string[] = [];
	if (process.env.PI_PACKAGE_DIR) starts.push(process.env.PI_PACKAGE_DIR);
	if (process.argv[1]) starts.push(process.argv[1]);
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir) starts.push(join(dir, "pi"));
	}
	for (const start of starts) {
		const resolved = realpathOrUndefined(start);
		if (!resolved) continue;
		const packageDir = findPiPackageDir(resolved);
		if (packageDir) return packageDir;
	}
	return undefined;
}

function findCoreChunk(packageDir: string): string | undefined {
	const chunksDir = join(packageDir, "dist", "bundle", "chunks");
	if (!existsSync(chunksDir)) return undefined;
	for (const file of readdirSync(chunksDir)) {
		if (!file.endsWith(".js")) continue;
		const chunk = join(chunksDir, file);
		if (readFileSync(chunk, "utf8").includes("require_core=__commonJS(")) return chunk;
	}
	return undefined;
}

/**
 * Register the Odin grammar on pi's highlight.js instance.
 * Returns an error message when the instance cannot be located.
 */
function registerOdinGrammar(): string | undefined {
	const packageDir = resolvePiPackageDir();
	if (!packageDir) return "could not find the pi install directory";

	const requireFromPi = createRequire(join(packageDir, "package.json"));
	try {
		const grammar = requireFromHere("./odin-grammar.cjs");
		const coreChunk = findCoreChunk(packageDir);
		if (coreChunk) {
			requireFromPi(coreChunk).require_core().registerLanguage("odin", grammar);
			return undefined;
		}
		// Unbundled layout: dist/utils/syntax-highlight.js imports this same
		// highlight.js copy, so registering here reaches the running instance.
		requireFromPi("highlight.js/lib/core.js").registerLanguage("odin", grammar);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export default function (pi: ExtensionAPI) {
	const failure = registerOdinGrammar();
	if (!failure) return;
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify(`Odin highlighting unavailable: ${failure}`, "warning");
	});
}

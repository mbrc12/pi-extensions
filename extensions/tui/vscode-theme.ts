/**
 * Switches pi to a different theme inside the VS Code / VSCodium integrated terminal.
 *
 * The global `theme` setting is never modified: the theme is applied at runtime only, so pi
 * keeps using the configured theme in every other terminal.
 *
 * Caveat: a theme applied at runtime is not re-resolved when the terminal reports new colors
 * or a light/dark appearance change, so restart pi after switching the editor's theme.
 *
 * Resuming a session, forking, `/new` and `/reload` re-apply the `theme` setting just after
 * session_start, which would otherwise drop the editor theme again; see REASSERT_DELAYS_MS.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Theme used in the editor's integrated terminal. Any built-in or custom theme name. */
const EDITOR_TERMINAL_THEME = "system";

/** Editors that identify themselves with `TERM_PROGRAM=vscode`: VS Code, VSCodium, and forks. */
const EDITOR_TERM_PROGRAM = "vscode";

/**
 * Delay after a switching session_start at which the editor theme is re-asserted. A session rebind
 * (resume, fork, `/new`, `/reload`) runs the extension binding mid-rebind and re-applies the `theme`
 * setting afterwards, at a point that is not part of the extension API, so the theme is re-checked a
 * few times instead of once. When nothing overwrote it, the check is a no-op.
 */
const REASSERT_DELAYS_MS = [0, 25, 100, 250, 1000, 2500];

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (process.env.TERM_PROGRAM !== EDITOR_TERM_PROGRAM) return;

		const theme = ctx.ui.getTheme(EDITOR_TERMINAL_THEME);
		if (!theme) {
			ctx.ui.notify(`pi: unknown theme "${EDITOR_TERMINAL_THEME}"`, "error");
			return;
		}

		// Pass the Theme instance, not its name: setting a name would also write the `theme`
		// setting to settings.json and replace the theme used outside the editor.
		ctx.ui.setTheme(theme);

		// Re-assert the theme while a session rebind settles. Setting an instance marks the theme
		// "<in-memory>", which keeps terminal-color reapplications away from it.
		for (const delay of REASSERT_DELAYS_MS) {
			setTimeout(() => {
				if (ctx.ui.theme !== theme) {
					ctx.ui.setTheme(theme);
				}
			}, delay);
		}
	});
}

/**
 * `/tmux-session [on|off|status|attach]`
 *
 * Opens or closes the tmux workspace that mirrors subagents and operators into
 * panes. The workspace is off by default, both commands are idempotent, and the
 * pi session that opened it closes it again when it shuts down or switches
 * sessions.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ensureWorkspace, getWorkspace, providePi, setWorkspace, TmuxWorkspace } from "../shared/tmux-session.ts";

const STATUS_KEY = "tmux-session";
const ACTIONS = ["on", "off", "status", "attach"] as const;

/** Create the workspace for the active session and publish it to the tool entries. */
function bindWorkspace(pi: ExtensionAPI, ctx: ExtensionCommandContext | any): TmuxWorkspace {
	const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "session";
	const workspace = new TmuxWorkspace(pi, sessionId, ctx?.cwd ?? process.cwd());
	setWorkspace(workspace);
	return workspace;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function tmuxSession(pi: ExtensionAPI): void {
	providePi(pi);
	pi.on("session_start", async (_event, ctx) => {
		bindWorkspace(pi, ctx);
		// Panes are opt-in per session, so a resumed session starts closed again.
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// The owner closes what it opened: on shutdown, and before the session id
	// changes, because the workspace name is derived from that id.
	for (const event of ["session_shutdown", "session_before_switch"] as const) {
		pi.on(event, async () => {
			const workspace = getWorkspace();
			if (!workspace?.isEnabled) return;
			await workspace.close().catch(() => {});
		});
	}

	pi.registerCommand("tmux-session", {
		description: "Open or close a tmux workspace with one pane per subagent and operator",
		getArgumentCompletions: (prefix: string) => {
			const value = prefix.trim().toLowerCase();
			const matches = ACTIONS.filter((action) => action.startsWith(value));
			return matches.length ? matches.map((action) => ({ value: action, label: action })) : null;
		},
		handler: async (args, ctx) => {
			const action = (args.trim().toLowerCase().split(/\s+/)[0] ?? "") || "status";
			const workspace = ensureWorkspace(ctx) ?? bindWorkspace(pi, ctx);

			if (action === "attach") {
				const status = await workspace.status();
				ctx.ui.notify(
					status.open
						? `Attach with: ${status.attachCommand}`
						: `${status.name} is not open. Run /tmux-session on first.`,
					status.open ? "info" : "warning",
				);
				return;
			}

			if (action === "off") {
				const result = await workspace.close();
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify(
					result.closed
						? `Closed tmux session ${result.name}. Running agents keep running and report back normally.`
						: `${result.name}: ${result.reason === "not open" ? "nothing to close." : `left alone, ${result.reason}.`}`,
					result.closed ? "info" : "warning",
				);
				return;
			}

			if (action === "on") {
				try {
					const result = await workspace.open();
					ctx.ui.setStatus(STATUS_KEY, result.name);
					ctx.ui.notify(
						[
							`${result.created ? "Opened" : "Reusing"} tmux session ${result.name} with ${result.windows.length} window(s).`,
							`Attach with: ${workspace.attachCommand}.`,
							"Each new subagent and operator gets a pane, and agents already running are attached now; finished panes stay until the workspace closes.",
						].join(" "),
						"info",
					);
				} catch (error) {
					ctx.ui.notify(`Could not open the tmux workspace: ${errorText(error)}`, "error");
				}
				return;
			}

			if (action !== "status") {
				ctx.ui.notify(`Unknown argument "${action}". Use on, off, status, or attach.`, "warning");
				return;
			}

			const status = await workspace.status();
			const lines = [
				`Workspace: ${status.name}`,
				`State: ${status.open ? (status.enabled ? "open, managed by this session" : "open, not managed by this session") : "closed"}`,
				`Tracked agents: ${status.agents}`,
				`Windows: ${status.windows.length ? status.windows.join(", ") : "none"}`,
				status.open ? `Attach with: ${status.attachCommand}` : "Run /tmux-session on to open it.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

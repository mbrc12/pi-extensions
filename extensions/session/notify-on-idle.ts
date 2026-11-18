import { execFile, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notificationsDisabled } from "../shared/notification-policy.ts";

export interface PromptWaitNotification {
	title: string;
	body: string;
}

export function promptWait(pi: ExtensionAPI, notification: PromptWaitNotification): void {
	pi.events.emit("prompt_wait", notification);
}

/** Where a notification goes once the terminal has been classified. */
export interface NotifySink {
	bell(): void;
	tmux(title: string, body: string): void;
	windows(title: string, body: string): void;
	osc77(title: string, body: string): void;
	osc99(title: string, body: string): void;
}

export type RunOrigin = "user" | "custom";

/**
 * A banner is only worth posting when your own prompt reached its final end.
 *
 * An aborted run means you are already at the keyboard. A run started by a
 * custom message is Pi continuing on its own: a subagent or task result, a
 * compaction note, or the context alert.
 */
export function shouldNotifyRun(origin: RunOrigin | undefined, aborted: boolean): boolean {
	return origin === "user" && !aborted;
}

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

/**
 * Inside tmux, hand the notification to tmux-notify instead of writing OSC 777
 * to the terminal. tmux cannot hook OSC sequences, so it can only pass them to
 * the outer terminal, which means the notice is lost when you are looking at a
 * different session. tmux-notify adds the session and window to the text and
 * posts a macOS banner of its own, so the alert survives iTerm2's notifications
 * being switched off. It renders nothing into the pane.
 */
function notifyTmux(title: string, body: string): void {
	const notifier = `${process.env.HOME}/.local/bin/tmux-notify`;
	const args = ["-t", title, "-b", body];
	if (process.env.TMUX_PANE) args.push("-p", process.env.TMUX_PANE);
	try {
		// Detached so the banner still lands if pi exits immediately after.
		const child = spawn(notifier, args, { detached: true, stdio: "ignore" });
		// A missing notifier reports asynchronously; without this the session dies.
		child.on("error", () => {});
		child.unref();
	} catch {
		// A failed notification must never disturb the session.
	}
}

const systemSink: NotifySink = {
	bell: () => {
		process.stdout.write("\x07");
	},
	tmux: notifyTmux,
	windows: (title, body) => {
		execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
	},
	osc77: (title, body) => {
		process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
	},
	osc99: (title, body) => {
		process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
		process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
	},
};

/**
 * Post one desktop notification, unless this process is a child Pi.
 *
 * The guard sits in front of the terminal classification, so a quiet child
 * writes no bell, no OSC sequence, and spawns no notifier. The sink is a
 * parameter so tests can observe every branch without touching the machine.
 */
export function notify(
	title: string,
	body: string,
	env: NodeJS.ProcessEnv = process.env,
	sink: NotifySink = systemSink,
): void {
	if (notificationsDisabled(env)) return;

	sink.bell();

	if (env.TMUX) {
		sink.tmux(title, body);
		return;
	}

	// No cmux branch by request: never call the cmux CLI or post into a cmux
	// workspace. Inside a cmux terminal this now falls through to OSC 777.
	if (env.WT_SESSION) {
		sink.windows(title, body);
		return;
	}

	if (env.KITTY_WINDOW_ID) {
		sink.osc99(title, body);
		return;
	}

	sink.osc77(title, body);
}

export default function (pi: ExtensionAPI) {
	/** What started the run in flight, from `before_agent_start`. */
	let origin: RunOrigin | undefined;

	pi.events.on("prompt_wait", (event) => {
		const notification = event as Partial<PromptWaitNotification> | undefined;
		notify(notification?.title ?? "Pi", notification?.body ?? "Waiting for input");
	});

	pi.on("session_start", () => {
		origin = undefined;
	});

	pi.on("before_agent_start", (event) => {
		origin = event.messageType;
	});

	// `agent_settled` is the only final boundary. `agent_end` fires again for
	// retries, compaction retries, and queued follow-ups, and `session_shutdown`
	// fires for every session switch, so neither belongs in a notification.
	pi.on("agent_settled", (event, ctx) => {
		const runOrigin = origin;
		origin = undefined;
		if (!ctx.hasUI || !ctx.isIdle()) return;
		if (!shouldNotifyRun(runOrigin, event.aborted)) return;
		notify("Pi", "Ready for input");
	});
}

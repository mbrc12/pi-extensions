import { execFile, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PromptWaitNotification {
	title: string;
	body: string;
}

export function promptWait(pi: ExtensionAPI, notification: PromptWaitNotification): void {
	pi.events.emit("prompt_wait", notification);
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

function bell(): void {
	process.stdout.write("\x07");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
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
		spawn(notifier, args, { detached: true, stdio: "ignore" }).unref();
	} catch {
		// A failed notification must never disturb the session.
	}
}

function notify(title: string, body: string): void {
	bell();

	if (process.env.TMUX) {
		notifyTmux(title, body);
		return;
	}

	// No cmux branch by request: never call the cmux CLI or post into a cmux
	// workspace. Inside a cmux terminal this now falls through to OSC 777.
	if (process.env.WT_SESSION) {
		notifyWindows(title, body);
		return;
	}

	if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(title, body);
		return;
	}

	notifyOSC777(title, body);
}

export default function (pi: ExtensionAPI) {
	pi.events.on("prompt_wait", (event) => {
		const notification = event as Partial<PromptWaitNotification> | undefined;
		notify(notification?.title ?? "Pi", notification?.body ?? "Waiting for input");
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		notify("Pi", "Ready for input");
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!ctx.hasUI) return;
		notify("Pi", `Process ended (${event.reason})`);
	});
}

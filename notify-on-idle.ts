import { execFile } from "node:child_process";
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

function notifyCmux(title: string, body: string): void {
	const command = process.env.CMUX_BUNDLED_CLI_PATH || "cmux";
	execFile(
		command,
		["notify", "--title", title, "--body", body],
		{ timeout: 5_000 },
		(error) => {
			// Keep notifications working if the cmux socket or CLI is unavailable.
			if (error) notifyOSC777(title, body);
		},
	);
}

function notify(title: string, body: string): void {
	bell();

	if (process.env.CMUX_SOCKET_PATH || process.env.CMUX_WORKSPACE_ID) {
		notifyCmux(title, body);
		return;
	}

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

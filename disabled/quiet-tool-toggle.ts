/**
 * Suppress Pi's transient "Tool output: expanded/collapsed" transcript rows.
 *
 * Pi emits those rows from InteractiveMode whenever Ctrl+O toggles tool output.
 * This extension leaves the toggle and all custom tool renderers intact; it only
 * removes that redundant status chatter.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const QUIET_STATUS = /^Tool output: (?:expanded|collapsed)$/;

type InteractiveModeWithStatus = InteractiveMode & {
	showStatus(message: string): void;
};

export default function quietToolToggleExtension(pi: ExtensionAPI): void {
	const prototype = InteractiveMode.prototype as InteractiveModeWithStatus;
	const originalShowStatus = prototype.showStatus;

	prototype.showStatus = function (message: string): void {
		if (QUIET_STATUS.test(message)) return;
		originalShowStatus.call(this, message);
	};

	pi.on("session_shutdown", () => {
		prototype.showStatus = originalShowStatus;
	});
}

/**
 * Minimal Tool Display Extension
 * 
 * Provides compact rendering for all built-in tools:
 * - Bash: Shows compressed command (truncated if too long)
 * - Read/Write/Edit: Shows just the path
 * - Uses renderShell: "self" to minimize padding
 * 
 * Usage:
 *   pi -e ~/.pi/agent/extensions/minimal-tools.ts
 */

import type { BashToolDetails, EditToolDetails, ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool, createFindTool, createGrepTool, createLsTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "os";

function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function compressCommand(cmd: string, maxLen: number = 60): string {
	if (cmd.length <= maxLen) return cmd;
	
	// Handle multi-line commands
	const lines = cmd.split("\n");
	if (lines.length > 1) {
		const firstLine = lines[0];
		return `${firstLine.substring(0, 40)}... (${lines.length - 1} more lines)`;
	}
	
	// Single long line: show start + ... + end
	return `${cmd.substring(0, 35)}...${cmd.slice(-20)}`;
}

const cwd = process.cwd();
const tools = {
	read: createReadTool(cwd),
	bash: createBashTool(cwd),
	edit: createEditTool(cwd),
	write: createWriteTool(cwd),
	find: createFindTool(cwd),
	grep: createGrepTool(cwd),
	ls: createLsTool(cwd),
};

export default function (pi: ExtensionAPI) {
	// Bash tool with compressed display
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: tools.bash.description,
		parameters: tools.bash.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return tools.bash.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const command = args.command || "...";
			const timeout = args.timeout as number | undefined;
			const timeoutSuffix = timeout ? theme.fg("muted", ` (${timeout}s)`) : "";
			
			if (context.expanded) {
				return new Text(theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("accent", command) + timeoutSuffix, 0, 0);
			}
			
			const compressed = compressCommand(command);
			return new Text(theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("accent", compressed) + timeoutSuffix, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "running..."), 0, 0);

			const content = result.content[0];
			const output = content?.type === "text" ? content.text : "";
			const exitMatch = output.match(/exit code: (\d+)/);
			const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;
			const lineCount = output.split("\n").filter((l) => l.trim()).length;

			let text = "";
			if (exitCode === 0 || exitCode === null) {
				text += theme.fg("success", "✓");
			} else {
				text += theme.fg("error", `✗ ${exitCode}`);
			}
			text += theme.fg("dim", ` ${lineCount} lines`);

			if (expanded && output) {
				const lines = output.split("\n").slice(0, 15);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// Read tool - minimal display
	pi.registerTool({
		name: "read",
		label: "read",
		description: tools.read.description,
		parameters: tools.read.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return tools.read.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const path = shortenPath(args.path || "");
			let text = theme.fg("toolTitle", theme.bold("read ")) + theme.fg("accent", path);
			if (context.expanded) {
				if (args.offset !== undefined) text += theme.fg("dim", ` offset=${args.offset}`);
				if (args.limit !== undefined) text += theme.fg("dim", ` limit=${args.limit}`);
			} else {
				if (args.offset !== undefined || args.limit !== undefined) {
					const startLine = args.offset ?? 1;
					const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
					text += theme.fg("dim", `:${startLine}${endLine ? `-${endLine}` : ""}`);
				}
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "reading..."), 0, 0);

			const details = result.details as ReadToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "image") {
				return new Text(theme.fg("success", "✓ image"), 0, 0);
			}

			if (content?.type !== "text") {
				return new Text(theme.fg("error", "✗ no content"), 0, 0);
			}

			const lineCount = content.text.split("\n").length;
			let text = theme.fg("success", `✓ ${lineCount} lines`);

			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " (truncated)");
			}

			return new Text(text, 0, 0);
		},
	});

	// Edit tool - minimal display
	pi.registerTool({
		name: "edit",
		label: "edit",
		description: tools.edit.description,
		parameters: tools.edit.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return tools.edit.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const path = shortenPath(args.path || "");
			let text = theme.fg("toolTitle", theme.bold("edit ")) + theme.fg("accent", path);
			if (context.expanded && args.oldText) {
				const preview = args.oldText.split("\n").slice(0, 3).join("\n");
				text += theme.fg("dim", `\n  -${preview.replace(/\n/g, "\n  -")}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "editing..."), 0, 0);

			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];

			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", "✗ " + content.text.split("\n")[0]), 0, 0);
			}

			if (!details?.diff) {
				return new Text(theme.fg("success", "✓ applied"), 0, 0);
			}

			// Count diff stats
			const diffLines = details.diff.split("\n");
			let additions = 0;
			let removals = 0;
			for (const line of diffLines) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}

			let text = theme.fg("success", `✓ +${additions}`) + theme.fg("dim", " / ") + theme.fg("error", `-${removals}`);

			if (expanded) {
				for (const line of diffLines.slice(0, 20)) {
					if (line.startsWith("+") && !line.startsWith("+++")) {
						text += `\n${theme.fg("success", line)}`;
					} else if (line.startsWith("-") && !line.startsWith("---")) {
						text += `\n${theme.fg("error", line)}`;
					}
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// Write tool - minimal display
	pi.registerTool({
		name: "write",
		label: "write",
		description: tools.write.description,
		parameters: tools.write.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return tools.write.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const path = shortenPath(args.path || "");
			const lineCount = args.content ? args.content.split("\n").length : 0;
			let text = theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", path);
			if (context.expanded) {
				text += theme.fg("dim", ` (${lineCount} lines)`);
			} else {
				text += theme.fg("dim", ` ${lineCount}L`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "writing..."), 0, 0);

			const content = result.content[0];
			if (content?.type === "text" && content.text.startsWith("Error")) {
				return new Text(theme.fg("error", "✗ " + content.text.split("\n")[0]), 0, 0);
			}

			return new Text(theme.fg("success", "✓ written"), 0, 0);
		},
	});

	// Find tool - minimal display
	pi.registerTool({
		name: "find",
		label: "find",
		description: tools.find.description,
		parameters: tools.find.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return tools.find.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			let text = theme.fg("toolTitle", theme.bold("find ")) + theme.fg("accent", pattern) + theme.fg("dim", ` in ${path}`);
			if (context.expanded && args.limit !== undefined) {
				text += theme.fg("dim", ` (limit ${args.limit})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "searching..."), 0, 0);

			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent?.type || textContent.type !== "text") {
				return new Text(theme.fg("dim", "—"), 0, 0);
			}

			const count = textContent.text.trim().split("\n").filter(Boolean).length;
			let text = theme.fg("success", `✓ ${count} files`);

			if (expanded && count > 0) {
				const lines = textContent.text.trim().split("\n").slice(0, 10);
				for (const line of lines) {
					text += `\n${theme.fg("dim", shortenPath(line))}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// Grep tool - minimal display
	pi.registerTool({
		name: "grep",
		label: "grep",
		description: tools.grep.description,
		parameters: tools.grep.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return tools.grep.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const pattern = args.pattern || "";
			const path = shortenPath(args.path || ".");
			let text = theme.fg("toolTitle", theme.bold("grep ")) + theme.fg("accent", `/${pattern}/`) + theme.fg("dim", ` in ${path}`);
			if (context.expanded) {
				if (args.glob) text += theme.fg("dim", ` (${args.glob})`);
				if (args.limit !== undefined) text += theme.fg("dim", ` limit ${args.limit}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "searching..."), 0, 0);

			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent?.type || textContent.type !== "text") {
				return new Text(theme.fg("dim", "—"), 0, 0);
			}

			const count = textContent.text.trim().split("\n").filter(Boolean).length;
			let text = theme.fg("success", `✓ ${count} matches`);

			if (expanded && count > 0) {
				const lines = textContent.text.trim().split("\n").slice(0, 10);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});

	// Ls tool - minimal display
	pi.registerTool({
		name: "ls",
		label: "ls",
		description: tools.ls.description,
		parameters: tools.ls.parameters,
		renderShell: "self",

		async execute(toolCallId, params, signal, onUpdate) {
			return tools.ls.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall(args, theme, context) {
			const path = shortenPath(args.path || ".");
			let text = theme.fg("toolTitle", theme.bold("ls ")) + theme.fg("accent", path);
			if (context.expanded && args.limit !== undefined) {
				text += theme.fg("dim", ` (limit ${args.limit})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, _context) {
			if (isPartial) return new Text(theme.fg("warning", "listing..."), 0, 0);

			const textContent = result.content.find((c) => c.type === "text");
			if (!textContent?.type || textContent.type !== "text") {
				return new Text(theme.fg("dim", "—"), 0, 0);
			}

			const count = textContent.text.trim().split("\n").filter(Boolean).length;
			let text = theme.fg("success", `✓ ${count} entries`);

			if (expanded && count > 0) {
				const lines = textContent.text.trim().split("\n").slice(0, 15);
				for (const line of lines) {
					text += `\n${theme.fg("dim", line)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}

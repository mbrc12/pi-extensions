import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STATE_ENTRY_TYPE = "notes:state";
const STATUS_ID = "notes";

type NotesState = {
	text: string;
};

function characterCount(text: string): number {
	return Array.from(text).length;
}

function lineCount(text: string): number {
	return text === "" ? 0 : text.split("\n").length;
}

function statusText(text: string): string {
	return `${characterCount(text)}C/${lineCount(text)}L`;
}

function isNotesState(value: unknown): value is NotesState {
	return typeof value === "object" && value !== null && typeof (value as NotesState).text === "string";
}

export default function (pi: ExtensionAPI) {
	let notes = "";

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", `📝 ${statusText(notes)}`));
	}

	function restore(ctx: ExtensionContext): void {
		notes = "";
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE || !isNotesState(entry.data)) continue;
			notes = entry.data.text;
		}
		updateStatus(ctx);
	}

	function save(text: string, ctx: ExtensionContext): void {
		notes = text;
		pi.appendEntry(STATE_ENTRY_TYPE, { text: notes } satisfies NotesState);
		updateStatus(ctx);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));

	pi.registerTool({
		name: "notes",
		label: "Notes",
		description: "Read or replace the current session scratchpad. Consult it with action read whenever you are idle.",
		promptSnippet: "Read or replace the current session scratchpad",
		promptGuidelines: [
			"Use notes with action read to check the session scratchpad whenever you are idle, and action write with the complete replacement text to update it.",
		],
		parameters: Type.Object({
			action: StringEnum(["read", "write"] as const, { description: "Read the notes or replace them" }),
			text: Type.Optional(Type.String({ description: "Complete replacement text for action write" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "read") {
				return {
					content: [{ type: "text", text: notes || "(The scratchpad is empty.)" }],
					details: { action: "read", text: notes, characters: characterCount(notes), lines: lineCount(notes) },
				};
			}

			if (params.text === undefined) {
				throw new Error("text is required when action is write");
			}

			save(params.text, ctx);
			return {
				content: [{ type: "text", text: `Saved notes (${statusText(notes)}).` }],
				details: { action: "write", text: notes, characters: characterCount(notes), lines: lineCount(notes) },
			};
		},
	});

	pi.registerCommand("notes", {
		description: "Open the current session scratchpad",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/notes requires interactive mode", "error");
				return;
			}

			const edited = await ctx.ui.editor("Session notes", notes);
			if (edited === undefined || edited === notes) return;
			save(edited, ctx);
			ctx.ui.notify(`Notes saved (${statusText(notes)}).`, "info");
		},
	});
}

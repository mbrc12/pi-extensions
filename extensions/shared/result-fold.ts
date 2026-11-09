import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Fold a result that carries no structured details — a tool error, a blocked
 * call, or a plain-text reply — into one row. The full text stays behind
 * Ctrl+O so a failure never floods the transcript.
 */

type TextPart = { type: string; text?: string };
type FoldableResult = { content?: TextPart[]; isError?: boolean };
type FoldTheme = { fg(color: string, text: string): string };

/** Columns kept in the collapsed row before the ellipsis. */
export const FOLD_MAX_COLUMNS = 120;

/** Every text part of a result, trailing whitespace removed. */
export function resultText(result: FoldableResult | undefined): string {
	const parts = Array.isArray(result?.content) ? result.content : [];
	return parts
		.filter((part): part is TextPart & { text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.replace(/\s+$/, "");
}

/** The configured expand key; a plain fallback keeps renderers usable in tests. */
function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "ctrl+o to expand";
	}
}

/** One physical row: whitespace collapsed, clipped with an ellipsis when cut. */
export function clipLine(text: string, maxColumns: number = FOLD_MAX_COLUMNS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (maxColumns < 2) return "";
	return flat.length > maxColumns ? `${flat.slice(0, maxColumns - 1)}…` : flat;
}

/**
 * Render the folded row, or the whole text when the row is expanded.
 * Errors are marked `✗`, plain replies `→`; the expand hint appears only when
 * something is hidden.
 */
export function foldedResult(
	result: FoldableResult | undefined,
	theme: FoldTheme,
	options: { expanded?: boolean; maxColumns?: number } = {},
): Text {
	const text = resultText(result);
	const failed = result?.isError === true;

	if (!text) {
		return new Text(theme.fg(failed ? "error" : "dim", failed ? "✗ failed" : "—"), 0, 0);
	}

	if (options.expanded) {
		return new Text(theme.fg(failed ? "error" : "toolOutput", text), 0, 0);
	}

	const flat = text.replace(/\s+/g, " ").trim();
	const line = clipLine(text, options.maxColumns);
	const icon = failed ? theme.fg("error", "✗ ") : theme.fg("muted", "→ ");
	const body = theme.fg(failed ? "error" : "text", line);
	const suffix = line.length < flat.length
		? theme.fg("dim", ` (${expandHint()})`)
		: "";
	return new Text(icon + body + suffix, 0, 0);
}

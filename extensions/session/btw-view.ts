/**
 * Ephemeral viewer for one `/btw` answer.
 *
 * The view is drawn as a centred overlay over the transcript, not as a
 * replacement screen, so the conversation stays visible around it. The panel
 * carries its own theme background, padding, accent marker, and rules; it closes
 * on Esc and writes nothing to the session.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Key, Markdown, matchesKey, ScrollView, truncateToWidth } from "@earendil-works/pi-tui";

export interface BtwViewDocument {
	answer: string;
	/** User question, absent for the default "what is happening" explanation. */
	question?: string;
	/** `provider/model` that produced the answer. */
	model?: string;
	/** Preformatted USD cost, when the provider reported one. */
	cost?: string;
	/** Display entries the model never saw. */
	omitted?: number;
}

export interface BtwViewOptions {
	/** Largest fraction of terminal rows the panel may use. Default: 0.8. */
	maxHeightFraction?: number;
}

const DEFAULT_MAX_HEIGHT_FRACTION = 0.8;
/** Columns of padding inside the panel background. */
const PAD_X = 2;
/** Rows of padding above and below the panel content. */
const PAD_Y = 1;
/** The overlay never grows past this many rows, even on a tall terminal. */
const MIN_MAX_ROWS = 8;
const ACCENT_MARK = "▐";

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Header metadata: the model and the cost of the request. */
export function describeBtwView(document: BtwViewDocument): string {
	return [document.model, document.cost].filter(Boolean).join(" · ");
}

/**
 * Read-only scrollable overlay for one explanation. The answer is terminal
 * Markdown inside a padded panel with the theme's custom-message background, so
 * it reads as a distinct card instead of more transcript. The header carries the
 * model and cost, the footer the scroll position and the close key.
 */
export function createBtwView(
	document: BtwViewDocument,
	options: BtwViewOptions = {},
) {
	return (tui: any, theme: any, _keybindings: any, done: () => void) => {
		const body = new Markdown(document.answer || "*(The model returned no text.)*", 0, 0, getMarkdownTheme());
		// follow: "none" starts the reader at the first line, not the last.
		const scroll = new ScrollView(body as any, { scrollbar: "auto", overscroll: "contain", follow: "none" });
		const background = (text: string) => theme.bg("customMessageBg", text);
		const maxHeightFraction = options.maxHeightFraction ?? DEFAULT_MAX_HEIGHT_FRACTION;

		const headerLines = (width: number): string[] => {
			const meta = describeBtwView(document);
			const lines = [
				truncateToWidth(
					`${theme.fg("accent", ACCENT_MARK)} ${theme.fg("accent", theme.bold("btw"))}${meta ? `  ${theme.fg("dim", meta)}` : ""}`,
					width,
				),
			];
			if (document.question) {
				lines.push(theme.fg("muted", truncateToWidth(`Q: ${clip(document.question, 300)}`, width)));
			}
			lines.push(theme.fg("borderAccent", "─".repeat(width)), "");
			return lines;
		};

		const footerLines = (width: number, position: string, omitted: string): string[] => [
			"",
			theme.fg("borderMuted", "─".repeat(width)),
			theme.fg("dim", truncateToWidth(`${position}${omitted} · ↑↓ PgUp/PgDn · Esc close`, width)),
		];

		/** Inner panel content at the given width, sized to the available rows. */
		const panel = {
			render(width: number): string[] {
				const innerWidth = Math.max(1, width);
				const head = headerLines(innerWidth);
				const contentLines = body.render(innerWidth);
				// Measure the footer at its shortest form; the position text only grows.
				const foot = footerLines(innerWidth, "0/0", document.omitted ? ` · ${document.omitted} earlier omitted` : "");
				const cap = Math.max(MIN_MAX_ROWS, Math.floor((tui.terminal?.rows ?? 24) * maxHeightFraction));
				const available = Math.max(1, cap - head.length - foot.length - PAD_Y * 2);
				const scrolling = contentLines.length > available;
				scroll.updateLayout(contentLines.length, available, () => tui.requestRender());
				const visible = scrolling
					? contentLines.slice(scroll.scrollTop, scroll.scrollTop + available)
					: contentLines;
				const firstLine = scrolling ? Math.min(contentLines.length, scroll.scrollTop + 1) : 1;
				const lastLine = scrolling ? Math.min(contentLines.length, scroll.scrollTop + available) : contentLines.length;
				const position = `${firstLine}–${lastLine}/${contentLines.length}`;
				const omitted = document.omitted ? ` · ${document.omitted} earlier omitted` : "";
				return [...head, ...visible, ...footerLines(innerWidth, position, omitted)];
			},
			invalidate(): void {
				body.invalidate();
				scroll.invalidate();
			},
		};

		const frame = new Box(PAD_X, PAD_Y, background);
		frame.addChild(panel);

		return {
			render(width: number): string[] {
				return frame.render(width);
			},
			handleInput(data: string): void {
				if (matchesKey(data, Key.escape)) done();
				else if (matchesKey(data, Key.up)) scroll.scrollBy(-1);
				else if (matchesKey(data, Key.down)) scroll.scrollBy(1);
				else if (matchesKey(data, Key.pageUp)) scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 1));
				else if (matchesKey(data, Key.pageDown)) scroll.scrollBy(Math.max(1, scroll.viewportHeight - 1));
			},
			invalidate(): void {
				frame.invalidate();
			},
		};
	};
}

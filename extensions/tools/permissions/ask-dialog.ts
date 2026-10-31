/**
 * Interactive allow/deny dialog for the permissions extension.
 *
 * Replaces ctx.ui.select for permission prompts. Shows a preview of the tool
 * call (truncated for very long commands) and lets the user expand it to the
 * full untruncated content with ctrl+o — the app.tools.expand keybinding,
 * the same key used to expand/collapse tool output — before answering.
 *
 * Controls:
 *   ctrl+o                 expand/collapse the full content
 *   ↑↓                     choose Allow/Deny (scroll when content overflows)
 *   PgUp / PgDn            scroll long content by a page
 *   Enter                  confirm (Allow)
 *   Esc                    deny / cancel
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Background colors accepted by theme.bg() in the TUI. */
export type DialogBackground =
  | "selectedBg"
  | "scrollbarThumb"
  | "userMessageBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg";

export interface AskDialogOptions {
  /** Bold first line, e.g. "⛔ DANGEROUS — This may be destructive!". */
  header: string;
  /** Optional dim subtitle, e.g. "Run bash command (523 chars)". */
  subtitle?: string;
  /** Preview shown by default; may be truncated. */
  preview: string;
  /** Full untruncated content, shown when the user expands. */
  full: string;
  /** True when preview is a truncated version of full. */
  truncated: boolean;
  /** Allow option label: "Allow", "Allow Anyway" or "Allow Once". */
  allowLabel: string;
  /** Deny option label. */
  denyLabel: string;
  /** Background fill for the whole dialog box, so it stands out from the transcript. */
  background: DialogBackground;
}

/** Max content lines shown at once; longer content scrolls. */
const MAX_CONTENT_LINES = 16;

/** The configured key for app.tools.expand (default: ctrl+o). */
function expandKeyName(): string {
  return keyText("app.tools.expand") || "ctrl+o";
}

/**
 * Ask the user to allow or deny a tool call, with the option to expand the
 * full command before answering.
 *
 * @returns true = allow, false = deny/cancel.
 */
export async function showAskDialog(
  ctx: ExtensionContext,
  options: AskDialogOptions,
): Promise<boolean> {
  if (!ctx.hasUI) return false;

  const result = await ctx.ui.custom<boolean | null>(
    (tui: any, theme: any, keybindings: any, done: (v: boolean | null) => void) => {
      let expanded = false; // false = preview, true = full content
      let selected = 0; // 0 = allow, 1 = deny
      let scroll = 0;
      let cachedWidth = 0;
      let cachedLines: string[] | undefined;

      const isExpandKey = (data: string): boolean => {
        try {
          return keybindings.matches(data, "app.tools.expand");
        } catch {
          return matchesKey(data, Key.ctrl("o"));
        }
      };

      function wrappedLines(width: number): string[] {
        const text = expanded ? options.full : options.preview;
        return wrapTextWithAnsi(text, Math.max(1, width - 2));
      }

      function refresh(): void {
        cachedLines = undefined;
        tui.requestRender();
      }

      function handleInput(data: string): void {
        if (isExpandKey(data)) {
          expanded = !expanded;
          scroll = 0;
          refresh();
          return;
        }

        const wrapped = wrappedLines(cachedWidth);
        const overflows = wrapped.length > MAX_CONTENT_LINES;
        const maxScroll = Math.max(0, wrapped.length - MAX_CONTENT_LINES);

        if (matchesKey(data, Key.pageUp)) {
          scroll = Math.max(0, scroll - MAX_CONTENT_LINES);
          refresh();
          return;
        }
        if (matchesKey(data, Key.pageDown)) {
          scroll = Math.min(maxScroll, scroll + MAX_CONTENT_LINES);
          refresh();
          return;
        }

        // When the content overflows, ↑↓ scroll it instead of moving the
        // selection. The decision keys (Enter/Esc) stay available.
        if (overflows && matchesKey(data, Key.up) && scroll > 0) {
          scroll--;
          refresh();
          return;
        }
        if (overflows && matchesKey(data, Key.down) && scroll < maxScroll) {
          scroll++;
          refresh();
          return;
        }

        if (matchesKey(data, Key.up)) {
          selected = 0;
          refresh();
          return;
        }
        if (matchesKey(data, Key.down)) {
          selected = 1;
          refresh();
          return;
        }

        if (matchesKey(data, Key.enter)) {
          done(selected === 0);
          return;
        }
        if (matchesKey(data, Key.escape)) {
          done(null);
          return;
        }
      }

      function render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;
        cachedWidth = width;
        const w = Math.max(1, width);
        const lines: string[] = [];

        const wrapped = wrappedLines(w);
        const overflows = wrapped.length > MAX_CONTENT_LINES;
        const maxScroll = Math.max(0, wrapped.length - MAX_CONTENT_LINES);
        scroll = Math.max(0, Math.min(scroll, maxScroll));
        const shown = wrapped.slice(scroll, scroll + MAX_CONTENT_LINES);

        // Top border + vertical padding.
        lines.push(theme.fg("accent", "─".repeat(w)));
        lines.push("");

        // Header row with a preview/full tag.
        const tag = expanded ? "[ full ]" : options.truncated ? "[ preview ]" : "";
        const header = theme.fg("text", theme.bold(options.header));
        lines.push(tag ? `${theme.fg("dim", tag + "  ")}${header}` : `  ${header}`);
        if (options.subtitle) lines.push(`  ${theme.fg("dim", options.subtitle)}`);
        lines.push("");

        // Content.
        for (const line of shown) lines.push(`  ${line}`);
        if (overflows) {
          const first = scroll + 1;
          const last = Math.min(scroll + MAX_CONTENT_LINES, wrapped.length);
          lines.push(theme.fg("dim", `  … ${first}–${last} of ${wrapped.length} lines`));
        } else if (options.truncated && !expanded) {
          const rest = options.full.length - options.preview.length;
          lines.push(theme.fg("dim", `  … (+${rest} more chars — ${expandKeyName()} to view full)`));
        }
        lines.push("");

        // Allow/Deny options.
        const opts = [options.allowLabel, options.denyLabel];
        for (let i = 0; i < opts.length; i++) {
          const prefix = i === selected ? theme.fg("accent", "> ") : "  ";
          const color = i === selected ? "accent" : "text";
          lines.push(`  ${prefix}${theme.fg(color, opts[i])}`);
        }
        lines.push("");

        // Help line.
        const parts: string[] = [];
        if (overflows) parts.push("↑↓/PgUp/PgDn scroll");
        else parts.push("↑↓ choose");
        if (options.truncated) parts.push(`${expandKeyName()} expand`);
        parts.push("Enter allow", "Esc deny");
        lines.push(`  ${theme.fg("dim", parts.join(" • "))}`);
        lines.push("");

        // Bottom border.
        lines.push(theme.fg("accent", "─".repeat(w)));

        // Truncate every line to the terminal width, then fill the whole box
        // with the dialog background (padded to full width) so it stands out
        // from the transcript. Truncation matters for un-wrappable lines such
        // as the subtitle (a long file path); without it the renderer throws
        // because a line exceeds the terminal width.
        const bgFn = (s: string) => theme.bg(options.background, s);
        cachedLines = lines.map((line) => {
          const fitted = truncateToWidth(line, w);
          const pad = Math.max(0, w - visibleWidth(fitted));
          return bgFn(fitted + " ".repeat(pad));
        });
        return cachedLines;
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput,
      };
    },
  );

  return result === true;
}

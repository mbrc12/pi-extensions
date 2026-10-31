import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, ScrollView, Text } from "@earendil-works/pi-tui";
import { getSessionDisplayEntries } from "../shared/session-display.ts";

export interface OperatorViewerDocument {
  name: string;
  agent: string;
  status: string;
  model: string;
  cwd?: string;
  sessionPath?: string;
  messages: any[];
}

export type OperatorViewerEntryRole = "user" | "system" | "tool" | "assistant";
export interface OperatorViewerEntry {
  role: OperatorViewerEntryRole;
  content: string;
  alwaysCompact?: boolean;
}
export interface OperatorViewerOptions {
  refreshIntervalMs?: number;
  /** Fraction of terminal rows the overlay may use. Default: 1 (full screen). */
  heightFraction?: number;
  /** Override Pi-message conversion when a caller already has structured transcript entries. */
  buildEntries?: (document: OperatorViewerDocument) => OperatorViewerEntry[];
}
export type OperatorViewerLoader = () => OperatorViewerDocument | string | Promise<OperatorViewerDocument | string>;

/** Convert Pi messages using the shared session display format. */
export function buildOperatorViewerEntries(document: OperatorViewerDocument): OperatorViewerEntry[] {
  return getSessionDisplayEntries(document.messages ?? [], { expanded: true }).map((entry) => ({
    role: entry.type,
    content: entry.type === "tool" ? `${entry.label}${entry.body ? `: ${entry.body}` : ""}` : entry.body,
    alwaysCompact: entry.fixed,
  }));
}

/** Italic styling for meta lines, with a plain fallback for minimal themes. */
function italicize(theme: any, text: string): string {
  if (typeof theme?.italic === "function") return theme.italic(text);
  if (typeof theme?.style === "function") return theme.style(text, { italic: true });
  return text;
}

/** Render structured transcript entries as compact TUI lines. */
export function renderOperatorViewerEntries(entries: OperatorViewerEntry[], width: number, theme: any, expanded = false, markdownTheme = getMarkdownTheme()): string[] {
  const output: string[] = [];
  for (const entry of entries) {
    if (!entry.content) continue;
    const compact = entry.content.replace(/\s+/g, " ");
    const value = expanded && !entry.alwaysCompact ? entry.content : compact.length > 200 ? `${compact.slice(0, 199)}…` : compact;
    if (entry.role === "assistant") {
      output.push(...new Text(theme.fg("dim", "-----"), 0, 0).render(width));
      output.push(...new Markdown(value, 0, 0, markdownTheme).render(width));
      output.push(...new Text(theme.fg("dim", "-----"), 0, 0).render(width));
    } else if (entry.role === "user") {
      output.push(...new Text(theme.fg("accent", "[user]"), 0, 0).render(width));
      output.push(...new Markdown(value, 0, 0, markdownTheme).render(width));
    } else {
      const label = `[${entry.role}]`;
      const labelColor = entry.role === "system" ? "warning" : "toolTitle";
      const body = value ? ` ${italicize(theme, value)}` : "";
      output.push(...new Text(`${theme.fg(labelColor, label)}${body}`, 0, 0).render(width));
    }
  }
  if (!output.length) output.push(...new Text("No conversation messages yet.", 0, 0).render(width));
  return output;
}

/** Read-only live viewer for compact operator transcripts. */
export function createOperatorViewer(load: OperatorViewerLoader, options: OperatorViewerOptions = {}) {
  return (tui: any, theme: any, _keybindings: any, done: () => void) => {
    let document: OperatorViewerDocument | string = "Loading…";
    let showPath = false;
    let expanded = false;
    let followEnd = true;
    const intervalMs = options.refreshIntervalMs ?? 2_000;
    const header = new Text("", 1, 0);
    const footer = new Text("", 1, 0);
    let contentLineCount = 0;
    const content = {
      render(width: number): string[] {
        if (typeof document === "string") return new Text(document || "(No content.)", 0, 0).render(width);
        const entries = options.buildEntries?.(document) ?? buildOperatorViewerEntries(document);
        const output = renderOperatorViewerEntries(entries, width, theme, expanded);
        contentLineCount = output.length;
        return output;
      },
      invalidate() {},
    };
    const scroll = new ScrollView(content as any, { scrollbar: "auto", overscroll: "contain", follow: "end" });
    let disposed = false;
    let loading = false;
    let generation = 0;

    const refresh = async () => {
      if (disposed || loading) return;
      loading = true;
      const currentGeneration = ++generation;
      const shouldFollow = followEnd && (contentLineCount === 0 || scroll.isFollowingEnd);
      try {
        const value = await load();
        if (!disposed && currentGeneration === generation) document = value;
      } catch (error) {
        if (!disposed && currentGeneration === generation) document = `Unable to refresh: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        loading = false;
        if (!disposed) {
          if (!shouldFollow) followEnd = false;
          content.invalidate(); scroll.invalidate(); header.invalidate(); tui.requestRender();
        }
      }
    };

    const timer = intervalMs > 0 ? setInterval(() => void refresh(), intervalMs) : undefined;
    void refresh();

    return {
      render(width: number): string[] {
        const terminalHeight = Math.max(1, Math.floor((tui.terminal?.rows ?? 24) * (options.heightFraction ?? 1)));
        const metadata = typeof document === "string"
          ? theme.fg("accent", theme.bold("Operator session"))
          : `${theme.fg("accent", theme.bold(document.name))} · ${document.agent} · ${document.status} · ${document.model || "model pending"}`;
        header.setText(metadata + (showPath && typeof document !== "string" && document.sessionPath ? `\n${theme.fg("dim", document.sessionPath)}` : ""));
        const headerLines = header.render(width);
        const contentLines = content.render(scroll.getContentWidth(width));
        const viewportHeight = Math.max(0, terminalHeight - headerLines.length - 1);
        scroll.updateLayout(contentLines.length, viewportHeight, () => tui.requestRender());
        if (followEnd) scroll.scrollToEnd();
        const firstLine = Math.min(contentLines.length, scroll.scrollTop + 1);
        const lastLine = Math.min(contentLines.length, scroll.scrollTop + viewportHeight);
        const position = contentLines.length ? `${firstLine}–${lastLine}/${contentLines.length}` : "0/0";
        footer.setText(theme.fg("dim", `${position} · ↑/↓ scroll · PgUp/PgDn page · Ctrl+O expand · r refresh · p path · Esc close`));
        return [...headerLines, ...contentLines.slice(scroll.scrollTop, scroll.scrollTop + viewportHeight), ...footer.render(width).slice(0, 1)].slice(0, terminalHeight);
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) done();
        else if (matchesKey(data, Key.up)) { followEnd = false; scroll.scrollBy(-1); }
        else if (matchesKey(data, Key.down)) { scroll.scrollBy(1); followEnd = scroll.isFollowingEnd; }
        else if (matchesKey(data, Key.pageUp)) { followEnd = false; scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 1)); }
        else if (matchesKey(data, Key.pageDown)) { scroll.scrollBy(Math.max(1, scroll.viewportHeight - 1)); followEnd = scroll.isFollowingEnd; }
        else if (matchesKey(data, Key.ctrl("o"))) { expanded = !expanded; content.invalidate(); scroll.invalidate(); tui.requestRender(); }
        else if (data === "r" || data === "R") void refresh();
        else if (data === "p" || data === "P") { showPath = !showPath; tui.requestRender(); }
      },
      invalidate(): void { header.invalidate(); content.invalidate(); scroll.invalidate(); footer.invalidate(); },
      dispose(): void { disposed = true; generation++; if (timer) clearInterval(timer); },
    };
  };
}

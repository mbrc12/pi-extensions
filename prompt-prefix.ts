/**
 * Prompt Prefix Extension
 *
 * Adds a » prefix before the editor prompt to visually distinguish it.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
const PREFIX = "» ";

class PromptPrefixEditor extends CustomEditor {
  render(width: number): string[] {
    const lines = super.render(width);
    // lines layout: [0] = top border, [1..] = content lines, [last] = bottom border
    // Prepend prefix only to the first content line (the input line)
    if (lines.length > 1) {
      const prefixWidth = visibleWidth(PREFIX);
      // Truncate the original line to fit, then prepend prefix
      const truncated = truncateToWidth(lines[1]!, width - prefixWidth);
      lines[1] = PREFIX + truncated;
    }

    return lines;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent(
      (tui, theme, kb) => new PromptPrefixEditor(tui, theme, kb)
    );
  });
}

/**
 * Compact startup banner.
 *
 * Replaces Pi's built-in startup header, which spends about six lines on the
 * logo, key hints, and an onboarding sentence. This banner uses two:
 *
 *   ▀█  v1.4.0 · 10 skills · 32 extensions · 3 prompts
 *   █▀  context ~/.pi/agent/APPEND_SYSTEM.md · ~/.pi/agent/AGENTS.md
 *
 * The left column is Pi's own half-block logo, or the "Pi" wordmark on terminals
 * that draw half blocks badly. The numbers come from the live session: skills and
 * prompt templates from their registered slash commands, context files from the
 * same files Pi puts in its `[Context]` section, and extensions from repeating
 * Pi's discovery rules over the agent and project extension directories.
 *
 * Set `"quietStartup": "header"` in `settings.json` to keep a header but drop
 * Pi's full loaded-resource listing; the counts here replace it. With
 * `"quietStartup": true` Pi shows no header and this extension stays out of the
 * way.
 *
 * `/banner off` restores the built-in header, `/banner logo` and
 * `/banner wordmark` choose the icon, and bare `/banner` reports the state.
 */

import {
  CONFIG_DIR_NAME,
  VERSION,
  getAgentDir,
  loadProjectContextFiles,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  backgroundAnsi,
  foregroundAnsi,
  isAppleTerminalSession,
  rgbColor,
  truncateToWidth,
  visibleWidth,
  type Color,
  type Component,
  type TerminalColorMode,
} from "@earendil-works/pi-tui";
import {
  ICON_WIDTH,
  bannerLines,
  contextFilePaths,
  countExtensions,
  displayPath,
  type BannerData,
  type BannerTheme,
} from "./banner-data.ts";

const RESET = "\x1b[0m";

// Pi's brand colors, kept fixed across themes so the logo stays recognizable.
const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);

/**
 * Pi's own logo, vendored from `pi-logo.ts` so the extension needs no private
 * import: 4 cells wide, 2 lines tall, half blocks over fixed brand colors. Both
 * cells are `ICON_WIDTH` cells wide, so the two text columns line up.
 */
export function iconCells(theme: Theme, logo: boolean): [string, string] {
  if (!logo) {
    const wordmark = ` ${theme.fg("accent", "Pi")}`;
    return [wordmark + " ".repeat(ICON_WIDTH - visibleWidth(wordmark)), " ".repeat(ICON_WIDTH)];
  }
  const mode: TerminalColorMode = theme.getColorMode();
  const fg = (color: Color) => foregroundAnsi(color, mode);
  const top = ` ${fg(CORAL)}${backgroundAnsi(BLUE, mode)}▀${RESET}${fg(CORAL)}▀█${RESET} `;
  const bottom = ` ${fg(BLUE)}█▀${RESET} ${fg(YELLOW)}█${RESET}`;
  return [top, bottom];
}

/** Read the banner numbers for the current session. */
export function collectBannerData(pi: ExtensionAPI, ctx: ExtensionContext): BannerData {
  const settings = pi.getSettings() as { extensions?: string[] };
  const agentDir = getAgentDir();
  const projectTrusted = ctx.isProjectTrusted();

  let commands: Array<{ source?: string }> = [];
  try {
    commands = pi.getCommands() as Array<{ source?: string }>;
  } catch {
    // Commands are unavailable before the session binds; the counts fall back to zero.
  }
  const countSource = (source: string) => commands.filter((command) => command.source === source).length;

  // Every loaded skill registers a `/skill:<name>` command, and prompt templates
  // register their own commands. The system-prompt options that hold the same
  // lists are not available to session_start handlers.
  const contextFiles = contextFilePaths({
    agentDir,
    cwd: ctx.cwd,
    configDirName: CONFIG_DIR_NAME,
    projectTrusted,
    agentsFiles: loadProjectContextFiles({ cwd: ctx.cwd, agentDir }).map((file) => file.path),
  });

  return {
    version: VERSION,
    contextFiles: contextFiles.map((path) => displayPath(path, { cwd: ctx.cwd })),
    counts: {
      skills: countSource("skill"),
      extensions: countExtensions({
        agentDir,
        cwd: ctx.cwd,
        projectTrusted,
        patterns: settings.extensions ?? [],
        configDirName: CONFIG_DIR_NAME,
      }),
      prompts: countSource("prompt"),
    },
  };
}

class CompactBanner implements Component {
  constructor(
    private readonly data: BannerData,
    private readonly theme: Theme,
    private readonly logo: boolean,
  ) {}

  render(width: number): string[] {
    const [iconTop, iconBottom] = iconCells(this.theme, this.logo);
    return bannerLines(this.data, this.theme as BannerTheme, width, {
      iconTop,
      iconBottom,
      truncate: truncateToWidth,
    });
  }

  invalidate(): void {}
}

/** Icon choice: the half-block logo, the text wordmark, or the terminal default. */
type IconMode = "auto" | "logo" | "wordmark";

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let iconMode: IconMode = "auto";
  const useLogo = () => (iconMode === "auto" ? !isAppleTerminalSession() : iconMode === "logo");

  const apply = (ctx: ExtensionContext): BannerData | undefined => {
    const settings = pi.getSettings() as { quietStartup?: boolean | "header" };
    // `quietStartup: true` means "no header at all"; leave that choice alone.
    if (settings.quietStartup === true) return undefined;
    const data = collectBannerData(pi, ctx);
    const logo = useLogo();
    ctx.ui.setHeader((_tui, theme) => new CompactBanner(data, theme, logo));
    return data;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !enabled) return;
    apply(ctx);
  });

  pi.registerCommand("banner", {
    description: "Compact startup banner: on, off, logo, wordmark",
    handler: async (args, ctx) => {
      const action = (args ?? "").trim().toLowerCase();
      if (action === "off") {
        enabled = false;
        ctx.ui.setHeader(undefined);
        ctx.ui.notify("Compact banner off: Pi's built-in header is back.", "info");
        return;
      }
      if (action === "on" || action === "logo" || action === "wordmark") {
        enabled = true;
        if (action !== "on") iconMode = action;
        const data = apply(ctx);
        if (!data) {
          ctx.ui.notify("quietStartup is true, so Pi shows no header. Set it to false to use the banner.", "warning");
          return;
        }
        ctx.ui.notify(action === "on" ? "Compact banner on." : `Banner icon: ${action}.`, "info");
        return;
      }
      const { counts } = collectBannerData(pi, ctx);
      ctx.ui.notify(
        `Compact banner is ${enabled ? "on" : "off"}; icon ${iconMode}. ${counts.skills} skills · ${counts.extensions} extensions · ${counts.prompts} prompts. Use /banner on|off|logo|wordmark.`,
        "info",
      );
    },
  });
}

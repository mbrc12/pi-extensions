/**
 * Show a clickable link to every image a tool returns.
 *
 * Pi draws images inline only when the terminal supports it. Inside tmux it
 * turns them off, and tmux drops the escape sequences anyway, so an image can
 * arrive with no visible trace. This renderer adds a link to the image file
 * under the tool result instead, which works in any terminal and survives
 * scrolling.
 */
import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text, getCapabilities, getImageDimensions, hyperlink } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { basename, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type Theme = Parameters<NonNullable<ToolRenderers["renderResult"]>>[2];
type RenderContext = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];

/** Files under the home directory are also served by the local file server. */
const PUBLIC_SERVER = "http://localhost:1002";
const HOME = homedir();

type ImagePart = { type: "image"; data: string; mimeType?: string };

function imageParts(result: Result | undefined): ImagePart[] {
	const content = (result as { content?: Array<{ type?: string }> } | undefined)?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((part): part is ImagePart => part?.type === "image" && typeof (part as ImagePart).data === "string");
}

function candidatePath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["path", "file_path", "filePath", "filename"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

function expandHome(rawPath: string): string {
	if (rawPath === "~") return HOME;
	if (rawPath.startsWith(`~${sep}`)) return HOME + rawPath.slice(1);
	return rawPath;
}

function publicUrl(absolutePath: string): string | undefined {
	const prefix = HOME.endsWith(sep) ? HOME : HOME + sep;
	if (!absolutePath.startsWith(prefix)) return undefined;
	const relativePath = absolutePath
		.slice(prefix.length)
		.split(sep)
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `${PUBLIC_SERVER}/${relativePath}`;
}

function describeImage(part: ImagePart, args: unknown, cwd: string, theme: Theme): string {
	const mimeType = part.mimeType ?? "image/png";
	const dimensions = getImageDimensions(part.data, mimeType) ?? undefined;
	const size = dimensions ? ` ${dimensions.widthPx}×${dimensions.heightPx}` : "";
	const rawPath = candidatePath(args);
	const absolutePath = rawPath ? resolve(cwd, expandHome(rawPath)) : undefined;
	const name = absolutePath ? basename(absolutePath) : mimeType.replace(/^image\//, "");

	const label = theme.fg("accent", theme.underline(`${name}${size}`));
	const url = absolutePath ? (publicUrl(absolutePath) ?? pathToFileURL(absolutePath).href) : undefined;
	if (!url) return label;
	if (getCapabilities().hyperlinks) return hyperlink(`${label} ${theme.fg("muted", "↗")}`, url);
	return `${label} ${theme.fg("muted", url)}`;
}

export default function imageLinks(pi: ExtensionAPI): void {
	pi.registerToolRenderer((_toolName, next) => {
		const native = next();
		return {
			...native,
			renderResult(result, options, theme, context: RenderContext) {
				const images = imageParts(result);
				if (images.length === 0) {
					return native?.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
				}

				// Render the stock result into a fresh component, then append our lines.
				const base = native?.renderResult?.(result, options, theme, { ...context, lastComponent: undefined });
				const container = new Container();
				if (base) container.addChild(base);
				for (const part of images) {
					container.addChild(new Text(describeImage(part, context.args, context.cwd, theme), 0, 0));
				}
				return container;
			},
		};
	});
}

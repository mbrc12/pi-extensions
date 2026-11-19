/**
 * Permissions extension - shared types.
 *
 * The policy lives in ~/.pi/agent/permissions.json and is enforced by two
 * layers: a Seatbelt profile for child processes, and the policy gate in
 * index.ts for in-process filesystem tools. Modes only decide how much the
 * user is asked, not what is allowed.
 */

/**
 * Three modes, one axis:
 *   allow   - bypass the permissions system: no gate, no sandbox
 *   sandbox - policy decides: kernel sandbox, allowlist, grant prompts for the rest
 *   ask     - prompt for every call, sandbox still on
 */
export type PermissionMode = "allow" | "sandbox" | "ask";

/** How many characters of a command or file body to show in a prompt. */
export const COMMAND_PREVIEW_LENGTH = 200;

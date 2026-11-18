/**
 * Who is allowed to post desktop notifications.
 *
 * Only the session you are sitting in front of notifies. A child Pi process
 * spawned by a subagent or an operator inherits the parent's `TMUX` and
 * `TMUX_PANE`, so without a marker its banner is indistinguishable from the
 * parent's — and it lands while the parent is still working.
 *
 * {@link NOTIFY_ENV} carries the marker. `notify-on-idle` refuses to write
 * anything when it is set to `"off"`, and every child spawn sets it, so the
 * flag also reaches grandchildren.
 */

export const NOTIFY_ENV = "PI_NOTIFY";

/** True when this process must not emit desktop notifications. */
export function notificationsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[NOTIFY_ENV] === "off";
}

/** Environment for a child Pi process: children never notify on their own. */
export function quietChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...source, [NOTIFY_ENV]: "off" };
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const RETRY_MS = 100;
export const SELF_COMPACT_NOTICE_PENDING = "self-compact-notice-pending";
export const SELF_COMPACT_NOTICE_SENT = "self-compact-notice-sent";

/** Hold completion messages until Pi can accept them without interrupting compaction. */
export function createNotificationGate(pi: ExtensionAPI, flush: () => void) {
	let ctx: ExtensionContext | undefined;
	let compacting = false;
	const waitingNotices = new Set<string>();
	let pending = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const clearTimer = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};

	const canSend = (): boolean => {
		// Completion hooks can run before Pi clears its compaction controller.
		// isIdle also covers preparation before our start hook and other awaited
		// extension hooks. Conservatively wait for an active agent run to finish.
		return ctx !== undefined && !compacting && waitingNotices.size === 0 && ctx.isIdle();
	};

	const drain = (): void => {
		clearTimer();
		if (!pending || !ctx) return;
		if (!canSend()) {
			// Do not poll during summarization. Its terminal event schedules a check.
			if (!compacting && waitingNotices.size === 0) {
				timer = setTimeout(drain, RETRY_MS);
				timer.unref?.();
			}
			return;
		}
		pending = false;
		flush();
	};

	const request = (): void => {
		pending = true;
		drain();
	};

	pi.on("session_before_compact", (_event, context) => {
		ctx = context;
		compacting = true;
		clearTimer();
	});

	const compactionFinished = (): void => {
		compacting = false;
		// Return from all completion hooks before checking Pi's idle state.
		if (pending && ctx && !timer) {
			timer = setTimeout(drain, 0);
			timer.unref?.();
		}
	};
	pi.on("session_compact", compactionFinished);
	pi.on("session_compact_failed", compactionFinished);

	// The terminal compaction event precedes self_compact's onComplete callback.
	// Keep its note first, even if that callback is delayed after Pi becomes idle.
	pi.events.on(SELF_COMPACT_NOTICE_PENDING, (data) => {
		waitingNotices.add((data as { id: string }).id);
		clearTimer();
	});
	pi.events.on(SELF_COMPACT_NOTICE_SENT, (data) => {
		waitingNotices.delete((data as { id: string }).id);
		if (pending && ctx && !timer) {
			timer = setTimeout(drain, 0);
			timer.unref?.();
		}
	});

	return {
		canSend,
		request,
		reset(context: ExtensionContext): void {
			clearTimer();
			ctx = context;
			compacting = false;
			waitingNotices.clear();
			pending = false;
		},
		dispose(): void {
			clearTimer();
			ctx = undefined;
			compacting = false;
			waitingNotices.clear();
			pending = false;
		},
	};
}

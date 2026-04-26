import type {
	Message as DiscordJsMessage,
	TextChannel,
	ThreadChannel,
} from 'discord.js';

type Sendable = TextChannel | ThreadChannel;

const EDIT_THROTTLE_MS = 1000;

/**
 * A single message at the bottom of a Discord channel that reflects the
 * agent's current activity ("🔄 Thinking…", "🔄 Running read_file source/foo.ts").
 *
 * Edits in place, throttled to one edit per second so we don't burn through
 * Discord's per-message edit rate limit. Coalesces rapid updates by remembering
 * the most recent text and applying it once the throttle window opens.
 *
 * Cleared (deleted) at end of run; the durable `✅ Done` marker is a separate
 * message owned by the caller, not by the status line.
 */
export class StatusLine {
	private channel: Sendable;
	private message: DiscordJsMessage | null = null;
	private latest = '';
	private applied = '';
	private lastEditAt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private cleared = false;

	constructor(channel: Sendable) {
		this.channel = channel;
	}

	/**
	 * Update the status text. Idempotent — calling with the same text twice
	 * in a row is a no-op. Lazily creates the underlying message on first call.
	 */
	async update(text: string): Promise<void> {
		if (this.cleared) return;
		if (text === this.latest) return;
		this.latest = text;

		// First call — actually send the message and skip the throttle.
		if (!this.message) {
			try {
				this.message = await this.channel.send(text);
				this.applied = text;
				this.lastEditAt = Date.now();
			} catch {
				// If the initial send fails, give up on this status line for the
				// rest of the run rather than retrying forever.
				this.cleared = true;
			}
			return;
		}

		const now = Date.now();
		const elapsed = now - this.lastEditAt;
		if (elapsed >= EDIT_THROTTLE_MS) {
			await this.flush();
		} else if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = null;
				void this.flush();
			}, EDIT_THROTTLE_MS - elapsed);
		}
	}

	/** Apply the latest pending text right now, ignoring the throttle. */
	private async flush(): Promise<void> {
		if (this.cleared || !this.message) return;
		if (this.latest === this.applied) return;
		const text = this.latest;
		try {
			await this.message.edit(text);
			this.applied = text;
			this.lastEditAt = Date.now();
		} catch {
			// Edit failures (rate limit, deleted message, perms) are non-fatal —
			// the next update cycle will try again.
		}
	}

	/** Delete the status message. Safe to call multiple times. */
	async clear(): Promise<void> {
		this.cleared = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.message) {
			await this.message.delete().catch(() => {});
			this.message = null;
		}
	}
}

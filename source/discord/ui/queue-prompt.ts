import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Message as DiscordJsMessage,
	type TextChannel,
	type ThreadChannel,
} from 'discord.js';

type Sendable = TextChannel | ThreadChannel;

/**
 * The two actions a user can take on queued messages while Derek is busy.
 * Handlers for these are resolved at interaction time in gateway.ts; the
 * QueuePrompt itself is a thin UI wrapper.
 */
export type QueueAction = 'background' | 'swap_to_thread';

export const QUEUE_BUTTON_PREFIX = 'queue';

/** Build the customId for a queue-prompt button. Format: queue:<nonce>:<action> */
export function queueButtonId(nonce: string, action: QueueAction): string {
	return `${QUEUE_BUTTON_PREFIX}:${nonce}:${action}`;
}

/** Parse a button customId back into its components, or null if not ours. */
export function parseQueueButtonId(
	customId: string,
): {nonce: string; action: QueueAction} | null {
	const parts = customId.split(':');
	if (parts.length !== 3) return null;
	if (parts[0] !== QUEUE_BUTTON_PREFIX) return null;
	const action = parts[2];
	if (action !== 'background' && action !== 'swap_to_thread') return null;
	return {nonce: parts[1], action};
}

const EDIT_THROTTLE_MS = 1000;

/**
 * The message + buttons shown when the user sends something while Derek is
 * already running a turn. Shows a live count of queued messages and offers
 * two routes: run them in a forked background thread, or swap the current
 * run into a thread so the queue can run in the main channel.
 *
 * Lifecycle:
 *   create → update (0+ times as more messages queue) → dismiss
 *
 * `dismiss()` is called when the queue drains naturally into a turn, or
 * when a button is pressed (the interaction handler also removes the
 * components to prevent stale presses after phase 3's placeholder reply).
 */
export class QueuePrompt {
	readonly nonce: string;

	private channel: Sendable;
	private message: DiscordJsMessage | null = null;
	private latestQueueCount = 0;
	private appliedQueueCount = -1;
	private lastEditAt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private dismissed = false;

	constructor(channel: Sendable, nonce: string) {
		this.channel = channel;
		this.nonce = nonce;
	}

	/** Idempotently update the displayed queue count. */
	async update(queueCount: number): Promise<void> {
		if (this.dismissed) return;
		if (queueCount === this.latestQueueCount && this.message) return;
		this.latestQueueCount = queueCount;

		if (!this.message) {
			try {
				this.message = await this.channel.send({
					content: formatQueueBody(queueCount),
					components: [buildRow(this.nonce)],
				});
				this.appliedQueueCount = queueCount;
				this.lastEditAt = Date.now();
			} catch {
				// Can't even create the prompt — give up for this run.
				this.dismissed = true;
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

	private async flush(): Promise<void> {
		if (this.dismissed || !this.message) return;
		if (this.latestQueueCount === this.appliedQueueCount) return;
		const count = this.latestQueueCount;
		try {
			await this.message.edit({
				content: formatQueueBody(count),
				components: [buildRow(this.nonce)],
			});
			this.appliedQueueCount = count;
			this.lastEditAt = Date.now();
		} catch {
			// Edit failures are non-fatal.
		}
	}

	/**
	 * Remove the prompt. Safe to call multiple times. Deletes the message
	 * by default; pass {keep: true} to leave the message but strip its
	 * buttons (used after a button press).
	 */
	async dismiss(opts: {keep?: boolean; note?: string} = {}): Promise<void> {
		if (this.dismissed) return;
		this.dismissed = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (!this.message) return;

		if (opts.keep) {
			const content = opts.note
				? `${formatQueueBody(this.latestQueueCount)}\n\n${opts.note}`
				: formatQueueBody(this.latestQueueCount);
			await this.message.edit({content, components: []}).catch(() => {});
		} else {
			await this.message.delete().catch(() => {});
		}
		this.message = null;
	}
}

function formatQueueBody(queueCount: number): string {
	const plural = queueCount === 1 ? 'message' : 'messages';
	return (
		`📬 **${queueCount} queued ${plural}** will run after the current turn finishes.\n` +
		`Use a button below to redirect, or ignore and they'll run in-channel.`
	);
}

function buildRow(nonce: string): ActionRowBuilder<ButtonBuilder> {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(queueButtonId(nonce, 'background'))
			.setLabel('🔀 Run queued in background')
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId(queueButtonId(nonce, 'swap_to_thread'))
			.setLabel('🧵 Move current to thread')
			.setStyle(ButtonStyle.Secondary),
	);
}

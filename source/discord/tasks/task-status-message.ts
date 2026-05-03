import type {
	Message as DiscordJsMessage,
	TextChannel,
	ThreadChannel,
} from 'discord.js';
import type {ChecklistItem, TaskRecord, TaskStatus} from './task-types.js';

type Sendable = TextChannel | ThreadChannel;

const EDIT_THROTTLE_MS = 1000;
const ELAPSED_REFRESH_INTERVAL_MS = 5000;

const MAX_CHECKLIST_ITEMS = 15;
const MAX_CHECKLIST_LABEL_LEN = 100;
// Leaving ~200 chars of headroom for header + checklist + code-block fences
// within Discord's 2000-char message limit.
const MAX_RESULT_LEN = 1300;
const MAX_ERROR_LEN = 700;
const MAX_TITLE_LEN = 120;
const SEPARATOR = '───────────────────────';

/** Status emoji for the title line. */
function statusEmoji(status: TaskStatus): string {
	switch (status) {
		case 'pending':
			return '🟡';
		case 'running':
			return '🟢';
		case 'succeeded':
			return '✅';
		case 'failed':
			return '❌';
		case 'cancelled':
			return '⏹';
	}
}

/** Status word for the header line. */
function statusWord(status: TaskStatus): string {
	return status;
}

function checklistGlyph(state: ChecklistItem['state']): string {
	switch (state) {
		case 'pending':
			return '○';
		case 'doing':
			return '▸';
		case 'done':
			return '✓';
		case 'skipped':
			return '↷';
	}
}

function formatElapsed(ms: number): string {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remSec = sec % 60;
	if (min < 60) return `${min}m ${remSec.toString().padStart(2, '0')}s`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return `${hr}h ${remMin.toString().padStart(2, '0')}m`;
}

function truncate(s: string, max: number, marker = '…'): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}${marker}`;
}

/**
 * Neutralize characters that would break out of the surrounding fenced
 * code block in the rendered status message. Agent output (results,
 * errors) frequently contains triple-backtick fences — if those land
 * verbatim inside our wrapping ```…``` the message renders broken, with
 * the tail of the task status spilling out as regular chat markdown.
 *
 * We replace backticks with U+02BB (a visually similar modifier letter)
 * so fences can't re-open and the text remains readable.
 */
function sanitizeForCodeBlock(s: string): string {
	return s.replace(/`/g, 'ʻ');
}

/**
 * Render the full task status message body. This is the *only* user-
 * visible surface for a task — one message, edited in place. The body
 * is wrapped in a fenced code block so Discord renders it as a single
 * monospace card visually distinct from surrounding chat.
 *
 * Markdown (bold, inline code) does not render inside code blocks, so
 * we use plain text and emoji for emphasis instead.
 *
 * Layout:
 *
 *   ```
 *   <emoji> <title> · <status> · <elapsed>[ · N tool calls] · task <id>
 *   <optional: checklist, one per line>
 *
 *   [optional: Result: / Error: / Cancelled: line on terminal]
 *   ───────────────────────
 *   ```
 */
export function renderTaskStatus(
	task: TaskRecord,
	now: number = Date.now(),
): string {
	const elapsed = task.endedAt
		? formatElapsed(task.endedAt - task.startedAt)
		: formatElapsed(now - task.startedAt);
	const tools =
		task.toolCallCount === 0
			? ''
			: ` · ${task.toolCallCount} tool call${
					task.toolCallCount === 1 ? '' : 's'
				}`;

	const title = sanitizeForCodeBlock(truncate(task.title, MAX_TITLE_LEN));
	const header = `${statusEmoji(task.status)} ${title} · ${statusWord(task.status)} · ${elapsed}${tools} · task ${task.id}`;

	const lines: string[] = [header];

	if (task.checklist.length > 0) {
		const items = task.checklist.slice(0, MAX_CHECKLIST_ITEMS).map(i => {
			const label = sanitizeForCodeBlock(
				truncate(i.label, MAX_CHECKLIST_LABEL_LEN),
			);
			return `${checklistGlyph(i.state)} ${label}`;
		});
		if (task.checklist.length > MAX_CHECKLIST_ITEMS) {
			items.push(
				`… +${task.checklist.length - MAX_CHECKLIST_ITEMS} more item${
					task.checklist.length - MAX_CHECKLIST_ITEMS === 1 ? '' : 's'
				}`,
			);
		}
		lines.push(...items);
	}

	if (task.status === 'succeeded' && task.lastResponse) {
		const result = sanitizeForCodeBlock(
			truncate(task.lastResponse, MAX_RESULT_LEN),
		);
		lines.push('', `Result: ${result}`);
	} else if (task.status === 'failed' && task.error) {
		const err = sanitizeForCodeBlock(truncate(task.error, MAX_ERROR_LEN));
		lines.push('', `Error: ${err}`);
	} else if (task.status === 'cancelled') {
		const reason = task.error
			? `: ${sanitizeForCodeBlock(truncate(task.error, MAX_ERROR_LEN))}`
			: '';
		lines.push('', `Cancelled${reason}`);
	}

	lines.push(SEPARATOR);

	return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

/**
 * Wraps the single status message for a task. Lifecycle:
 *   1. `TaskStatusMessage.create(channel, task)` posts the message.
 *   2. As the task runs, the runner calls `updateTask(task)` each time
 *      anything persisted changes (status, checklist, tool count). That
 *      queues a throttled edit.
 *   3. A background interval re-renders every 5s so the elapsed time
 *      stays fresh while the task is running.
 *   4. On terminal transition, `finalize(task)` flushes the final render
 *      and cancels the interval.
 *
 * All edits are throttled to 1/sec and failures are swallowed (Discord
 * rate-limits, deleted messages, etc. shouldn't crash the task driver).
 */
export class TaskStatusMessage {
	private channel: Sendable;
	private message: DiscordJsMessage | null = null;
	private task: TaskRecord;

	private latest: string;
	private applied: string;
	private lastEditAt = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private refreshInterval: ReturnType<typeof setInterval> | null = null;
	private finalized = false;

	private constructor(
		channel: Sendable,
		task: TaskRecord,
		message: DiscordJsMessage | null,
	) {
		this.channel = channel;
		this.task = task;
		this.message = message;
		this.latest = renderTaskStatus(task);
		this.applied = this.latest;
		this.lastEditAt = Date.now();
	}

	/**
	 * Post a fresh status message and return the wrapper. Returns null if
	 * the initial send fails (caller should treat that as a hard error —
	 * without a status message there's no task UI).
	 */
	static async create(
		channel: Sendable,
		task: TaskRecord,
	): Promise<TaskStatusMessage | null> {
		const body = renderTaskStatus(task);
		let msg: DiscordJsMessage;
		try {
			msg = await channel.send(body);
		} catch (err) {
			console.error('[TaskStatusMessage.create] failed to post:', err);
			return null;
		}

		const wrapper = new TaskStatusMessage(channel, task, msg);
		wrapper.startRefreshInterval();
		return wrapper;
	}

	/**
	 * Reattach to an existing status message (used by `continueTask`).
	 * If the message can no longer be fetched/edited, a fresh one is
	 * posted in the same channel.
	 */
	static async reattach(
		channel: Sendable,
		task: TaskRecord,
		messageId: string,
	): Promise<TaskStatusMessage> {
		let msg: DiscordJsMessage | null = null;
		try {
			msg = await channel.messages.fetch(messageId);
		} catch (err) {
			console.warn(
				`[TaskStatusMessage.reattach] could not fetch ${messageId}, posting fresh:`,
				err instanceof Error ? err.message : err,
			);
		}
		if (!msg) {
			const fresh = await TaskStatusMessage.create(channel, task);
			if (!fresh) {
				// Fall back to a wrapper with no message — edits will be no-ops.
				return new TaskStatusMessage(channel, task, null);
			}
			return fresh;
		}
		const wrapper = new TaskStatusMessage(channel, task, msg);
		wrapper.startRefreshInterval();
		return wrapper;
	}

	/** The Discord message id this status lives in, or empty if send failed. */
	getMessageId(): string {
		return this.message?.id ?? '';
	}

	/** The channel id the status message lives in. */
	getChannelId(): string {
		return this.channel.id;
	}

	/**
	 * Update the in-memory task snapshot and schedule a re-render of the
	 * status message. Throttled.
	 */
	updateTask(task: TaskRecord): void {
		this.task = task;
		this.scheduleEdit();
	}

	/**
	 * Flush the final state and stop the background refresh interval.
	 * Call exactly once per task, on terminal transition.
	 */
	async finalize(task: TaskRecord): Promise<void> {
		this.finalized = true;
		this.task = task;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
		// Force one final flush even if inside the throttle window.
		this.latest = renderTaskStatus(this.task);
		await this.flushNow();
	}

	// ─── internals ──────────────────────────────────────────────────────────

	private startRefreshInterval(): void {
		this.refreshInterval = setInterval(() => {
			if (this.finalized) return;
			// Re-render from the current task snapshot so the elapsed timer
			// keeps moving even when nothing else changed.
			this.latest = renderTaskStatus(this.task);
			void this.tryFlushThrottled();
		}, ELAPSED_REFRESH_INTERVAL_MS);
		this.refreshInterval.unref?.();
	}

	private scheduleEdit(): void {
		this.latest = renderTaskStatus(this.task);
		void this.tryFlushThrottled();
	}

	private async tryFlushThrottled(): Promise<void> {
		if (!this.message || this.finalized) return;
		const now = Date.now();
		const elapsed = now - this.lastEditAt;
		if (elapsed >= EDIT_THROTTLE_MS) {
			await this.flushNow();
		} else if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = null;
				void this.flushNow();
			}, EDIT_THROTTLE_MS - elapsed);
		}
	}

	private async flushNow(): Promise<void> {
		if (!this.message) return;
		if (this.latest === this.applied) return;
		const text = this.latest;
		try {
			await this.message.edit(text);
			this.applied = text;
			this.lastEditAt = Date.now();
		} catch {
			// Edit failures (rate limit, deleted message, perms) are non-fatal.
		}
	}
}

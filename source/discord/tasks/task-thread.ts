import type {
	Message as DiscordJsMessage,
	TextChannel,
	ThreadChannel,
} from 'discord.js';
import {DetailThread} from '../ui/progress-thread.js';
import type {ChecklistItem, TaskRecord, TaskStatus} from './task-types.js';

const HEADER_EDIT_THROTTLE_MS = 1000;
const REASONING_EDIT_THROTTLE_MS = 1000;

/** Status badge for the header message. */
function statusBadge(status: TaskStatus): string {
	switch (status) {
		case 'pending':
			return '🟡 pending';
		case 'running':
			return '🟢 running';
		case 'succeeded':
			return '✅ succeeded';
		case 'failed':
			return '❌ failed';
		case 'cancelled':
			return '⏹ cancelled';
	}
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

/**
 * Render the task header message body. Edited in place to track status,
 * elapsed time, tool count, and checklist progress.
 */
export function renderTaskHeader(
	task: TaskRecord,
	now: number = Date.now(),
): string {
	const elapsed = task.endedAt
		? formatElapsed(task.endedAt - task.startedAt)
		: formatElapsed(now - task.startedAt);
	const tools =
		task.toolCallCount === 0
			? ''
			: ` · ${task.toolCallCount} tool call${task.toolCallCount === 1 ? '' : 's'}`;
	const lines = [
		`${statusBadge(task.status)} **${task.title}** · ${elapsed}${tools}`,
		`\`task ${task.id}\``,
	];
	if (task.checklist.length > 0) {
		lines.push('');
		for (const item of task.checklist) {
			lines.push(`${checklistGlyph(item.state)} ${item.label}`);
		}
	}
	if (task.error && task.status === 'failed') {
		lines.push('', `**Error:** ${task.error}`);
	}
	return lines.join('\n');
}

/**
 * Wraps the Discord thread for a task. Owns the header message
 * (in-place edits), the live "thinking" message (in-place edits while
 * tokens stream), and delegates per-tool-call records to DetailThread.
 *
 * Lifecycle:
 *   1. `await TaskThread.create(parentTriggerMessage, task)` — opens the
 *      thread, posts the header message, returns the wrapper.
 *   2. The runner calls `onToken`, `recordToolStart`, `recordToolResult`
 *      as the runtime emits them.
 *   3. On terminal transition the runner calls `postTerminalBanner` and
 *      one final `refreshHeader`.
 */
export class TaskThread {
	private thread: ThreadChannel;
	private task: TaskRecord;

	private headerMessage: DiscordJsMessage | null = null;
	private headerLatest: string;
	private headerApplied: string;
	private headerLastEditAt = 0;
	private headerTimer: ReturnType<typeof setTimeout> | null = null;

	private detail: DetailThread;

	private reasoningMessage: DiscordJsMessage | null = null;
	private reasoningBuffer = '';
	private reasoningApplied = '';
	private reasoningLastEditAt = 0;
	private reasoningTimer: ReturnType<typeof setTimeout> | null = null;

	/** Refresh the elapsed-time display on a regular interval while running. */
	private refreshInterval: ReturnType<typeof setInterval> | null = null;

	private constructor(
		thread: ThreadChannel,
		task: TaskRecord,
		headerMessage: DiscordJsMessage,
	) {
		this.thread = thread;
		this.task = task;
		this.headerMessage = headerMessage;
		this.headerLatest = renderTaskHeader(task);
		this.headerApplied = this.headerLatest;
		this.headerLastEditAt = Date.now();
		this.detail = new DetailThread(thread);
	}

	/**
	 * Reattach to an existing task thread (used by `continueTask`). The
	 * thread and header message already exist — we just wrap them in a
	 * fresh TaskThread so the streaming/header plumbing works again.
	 */
	static reattach(
		thread: ThreadChannel,
		task: TaskRecord,
		headerMessage: DiscordJsMessage | null,
	): TaskThread {
		// Construct with a dummy-but-never-used header and then overwrite the
		// headerMessage field with whatever we actually have.
		const fakeHeader = headerMessage ?? (null as unknown as DiscordJsMessage);
		const tt = new TaskThread(thread, task, fakeHeader);
		if (!headerMessage) tt.headerMessage = null;
		tt.refreshInterval = setInterval(() => {
			void tt.refreshHeader();
		}, 5_000);
		tt.refreshInterval.unref?.();
		return tt;
	}

	static async create(
		triggerMessage: DiscordJsMessage,
		task: TaskRecord,
	): Promise<TaskThread | null> {
		if (!('startThread' in triggerMessage)) return null;
		let thread: ThreadChannel;
		try {
			thread = await triggerMessage.startThread({
				name: `⚙️ ${task.title.slice(0, 95)}`,
				autoArchiveDuration: 60,
			});
		} catch (err) {
			console.error('[TaskThread.create] failed to start thread:', err);
			return null;
		}

		const body = renderTaskHeader(task);
		let headerMsg: DiscordJsMessage;
		try {
			headerMsg = await thread.send(body);
		} catch (err) {
			console.error('[TaskThread.create] failed to post header:', err);
			return null;
		}

		const tt = new TaskThread(thread, task, headerMsg);
		tt.refreshInterval = setInterval(() => {
			void tt.refreshHeader();
		}, 5_000);
		// Don't keep the process alive on this timer.
		tt.refreshInterval.unref?.();
		return tt;
	}

	getThread(): ThreadChannel {
		return this.thread;
	}

	getThreadId(): string {
		return this.thread.id;
	}

	getHeaderMessageId(): string {
		return this.headerMessage?.id ?? '';
	}

	/** Update the in-memory task snapshot used for header rendering. */
	updateTask(task: TaskRecord): void {
		this.task = task;
		void this.refreshHeader();
	}

	/** Re-render the header from the current task snapshot, with throttling. */
	async refreshHeader(): Promise<void> {
		const text = renderTaskHeader(this.task);
		if (text === this.headerLatest && this.headerMessage) {
			// No content change, but still might want to bump elapsed display
			// when running. Fall through; the throttle will absorb it.
		}
		this.headerLatest = text;

		if (!this.headerMessage) return;
		const now = Date.now();
		const elapsed = now - this.headerLastEditAt;
		if (elapsed >= HEADER_EDIT_THROTTLE_MS) {
			await this.flushHeader();
		} else if (!this.headerTimer) {
			this.headerTimer = setTimeout(() => {
				this.headerTimer = null;
				void this.flushHeader();
			}, HEADER_EDIT_THROTTLE_MS - elapsed);
		}
	}

	private async flushHeader(): Promise<void> {
		if (!this.headerMessage) return;
		if (this.headerLatest === this.headerApplied) return;
		const text = this.headerLatest;
		try {
			await this.headerMessage.edit(text);
			this.headerApplied = text;
			this.headerLastEditAt = Date.now();
		} catch {
			// Edit failures are non-fatal; next tick will retry.
		}
	}

	/**
	 * Token streaming: appends to a single live "💭" message and edits
	 * it in place. Call `finalizeReasoning()` when the LLM round ends so
	 * the next round opens a fresh message.
	 */
	async onToken(token: string): Promise<void> {
		this.reasoningBuffer += token;

		if (!this.reasoningMessage) {
			try {
				this.reasoningMessage = await this.thread.send(
					formatReasoning(this.reasoningBuffer),
				);
				this.reasoningApplied = this.reasoningBuffer;
				this.reasoningLastEditAt = Date.now();
			} catch {
				// Bail on this reasoning bubble for the rest of this round.
				this.reasoningMessage = null;
			}
			return;
		}

		const now = Date.now();
		const elapsed = now - this.reasoningLastEditAt;
		if (elapsed >= REASONING_EDIT_THROTTLE_MS) {
			await this.flushReasoning();
		} else if (!this.reasoningTimer) {
			this.reasoningTimer = setTimeout(() => {
				this.reasoningTimer = null;
				void this.flushReasoning();
			}, REASONING_EDIT_THROTTLE_MS - elapsed);
		}
	}

	private async flushReasoning(): Promise<void> {
		if (!this.reasoningMessage) return;
		if (this.reasoningBuffer === this.reasoningApplied) return;
		const body = formatReasoning(this.reasoningBuffer);
		try {
			await this.reasoningMessage.edit(body);
			this.reasoningApplied = this.reasoningBuffer;
			this.reasoningLastEditAt = Date.now();
		} catch {
			// Non-fatal.
		}
	}

	/**
	 * Close out the current reasoning bubble. The next onToken call will
	 * open a fresh message. Call when the LLM round is done (i.e. before
	 * tool execution starts on a fresh round of tool calls).
	 */
	async finalizeReasoning(): Promise<void> {
		if (this.reasoningTimer) {
			clearTimeout(this.reasoningTimer);
			this.reasoningTimer = null;
		}
		await this.flushReasoning();
		this.reasoningMessage = null;
		this.reasoningBuffer = '';
		this.reasoningApplied = '';
	}

	async recordToolStart(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<void> {
		// Reasoning bubble was talking about *this* tool; close it.
		await this.finalizeReasoning();
		await this.detail.recordStart(toolName, args);
	}

	async recordToolResult(
		toolName: string,
		result: string,
		isError: boolean,
	): Promise<void> {
		await this.detail.recordResult(toolName, result, isError);
	}

	async postTerminalBanner(task: TaskRecord): Promise<void> {
		this.task = task;
		await this.finalizeReasoning();
		await this.refreshHeader();
		// Force a final edit even if throttle hasn't elapsed.
		await this.flushHeader();

		let banner: string;
		if (task.status === 'succeeded') {
			banner = `✅ Task complete · ${task.toolCallCount} tool call${
				task.toolCallCount === 1 ? '' : 's'
			} · ${formatElapsed((task.endedAt ?? Date.now()) - task.startedAt)}`;
		} else if (task.status === 'cancelled') {
			banner = `⏹ Cancelled${task.error ? `: ${task.error}` : ''}`;
		} else {
			banner = `❌ Failed${task.error ? `: ${task.error}` : ''}`;
		}
		await this.thread.send(banner).catch(() => {});

		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
			this.refreshInterval = null;
		}
	}
}

const REASONING_PREVIEW_LIMIT = 1800;

function formatReasoning(buffer: string): string {
	const trimmed =
		buffer.length > REASONING_PREVIEW_LIMIT
			? `${buffer.slice(-REASONING_PREVIEW_LIMIT)}\n…(truncated, ${buffer.length} chars total)`
			: buffer;
	return `💭 ${trimmed}`;
}

/**
 * Post the terminal-state notification in the *parent* channel so the
 * operator sees the result without opening the thread.
 */
export async function postParentNotification(
	parentChannel: TextChannel | ThreadChannel,
	task: TaskRecord,
	thread: ThreadChannel,
): Promise<void> {
	const elapsed = formatElapsed((task.endedAt ?? Date.now()) - task.startedAt);
	const tools = `${task.toolCallCount} tool call${task.toolCallCount === 1 ? '' : 's'}`;
	let icon = '✅';
	let label = 'succeeded';
	if (task.status === 'failed') {
		icon = '❌';
		label = 'failed';
	} else if (task.status === 'cancelled') {
		icon = '⏹';
		label = 'cancelled';
	}
	const reason =
		task.status !== 'succeeded' && task.error
			? `\n${task.error.slice(0, 400)}`
			: '';
	await parentChannel
		.send(
			`📋 Task **${task.title}** ${icon} ${label} · ${tools} · ${elapsed} — see ${thread.toString()}${reason}`,
		)
		.catch(() => {});
}

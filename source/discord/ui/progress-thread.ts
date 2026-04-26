import type {
	Message as DiscordJsMessage,
	TextChannel,
	ThreadChannel,
} from 'discord.js';
import type {ProgressStep} from '../types.js';
import {formatProgress, formatToolResult} from './message-formatter.js';

const EDIT_THROTTLE_MS = 2000; // Don't edit faster than every 2s

/**
 * Create a progress thread for a long-running task.
 * Returns a ProgressTracker that can be used to update progress.
 */
export async function createProgressThread(
	channel: TextChannel,
	triggerMessage: DiscordJsMessage,
	title: string,
): Promise<ProgressTracker> {
	// Create thread from the trigger message
	const thread = await triggerMessage.startThread({
		name: `🔧 ${title.slice(0, 95)}`,
		autoArchiveDuration: 60,
	});

	// Post initial progress message
	const progressMsg = await thread.send(formatProgress([], `⏳ ${title}`));

	return new ProgressTracker(thread, progressMsg, title);
}

export class ProgressTracker {
	private thread: ThreadChannel;
	private progressMessage: DiscordJsMessage;
	private steps: ProgressStep[] = [];
	private title: string;
	private lastEditTime = 0;
	private pendingEdit = false;
	private editTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		thread: ThreadChannel,
		progressMessage: DiscordJsMessage,
		title: string,
	) {
		this.thread = thread;
		this.progressMessage = progressMessage;
		this.title = title;
	}

	getThread(): ThreadChannel {
		return this.thread;
	}

	/**
	 * Add a step and update the progress message.
	 */
	async addStep(label: string): Promise<void> {
		// Mark any currently running step as complete
		for (const step of this.steps) {
			if (step.status === 'running') {
				step.status = 'complete';
			}
		}

		this.steps.push({label, status: 'running'});
		await this.updateProgress();
	}

	/**
	 * Complete the current step.
	 */
	async completeCurrentStep(): Promise<void> {
		const current = this.steps.find(s => s.status === 'running');
		if (current) {
			current.status = 'complete';
			await this.updateProgress();
		}
	}

	/**
	 * Mark the current step as errored.
	 */
	async errorCurrentStep(detail?: string): Promise<void> {
		const current = this.steps.find(s => s.status === 'running');
		if (current) {
			current.status = 'error';
			current.detail = detail;
			await this.updateProgress();
		}
	}

	/**
	 * Post a detailed message in the thread (e.g., tool output).
	 */
	async postDetail(content: string): Promise<void> {
		const truncated =
			content.length > 1900 ? content.slice(0, 1900) + '\n…' : content;
		await this.thread.send(truncated).catch(() => {});
	}

	/**
	 * Post a tool result in the thread.
	 */
	async postToolResult(
		toolName: string,
		result: string,
		isError: boolean,
	): Promise<void> {
		const formatted = formatToolResult(toolName, result, isError);
		// Split if too long
		if (formatted.length <= 2000) {
			await this.thread.send(formatted).catch(() => {});
		} else {
			await this.thread
				.send(`${isError ? '❌' : '✅'} **${toolName}** (output truncated)`)
				.catch(() => {});
		}
	}

	/**
	 * Mark the entire task as complete.
	 */
	async complete(summary?: string): Promise<void> {
		// Mark any remaining running steps as complete
		for (const step of this.steps) {
			if (step.status === 'running') {
				step.status = 'complete';
			}
		}

		const text = formatProgress(this.steps, `✅ ${this.title}`);
		await this.progressMessage
			.edit(summary ? `${text}\n\n${summary}` : text)
			.catch(() => {});
	}

	/**
	 * Mark the entire task as failed.
	 */
	async fail(error: string): Promise<void> {
		for (const step of this.steps) {
			if (step.status === 'running') {
				step.status = 'error';
				step.detail = error;
			}
		}

		const text = formatProgress(this.steps, `❌ ${this.title}`);
		await this.progressMessage.edit(text).catch(() => {});
	}

	private async updateProgress(): Promise<void> {
		const now = Date.now();
		if (now - this.lastEditTime < EDIT_THROTTLE_MS) {
			// Throttle edits — schedule one for later
			if (!this.editTimer) {
				this.editTimer = setTimeout(
					async () => {
						this.editTimer = null;
						await this.doEdit();
					},
					EDIT_THROTTLE_MS - (now - this.lastEditTime),
				);
			}
			return;
		}
		await this.doEdit();
	}

	private async doEdit(): Promise<void> {
		this.lastEditTime = Date.now();
		const text = formatProgress(this.steps, `⏳ ${this.title}`);
		await this.progressMessage.edit(text).catch(() => {});
	}
}

import type {
	Message as DiscordJsMessage,
	TextChannel,
	ThreadChannel,
} from 'discord.js';

/**
 * A detail thread opened off a user's trigger message. Accumulates the
 * full per-tool-call record (start line, args, result) as append-only
 * messages — no edits, no progress bar, no step list. The main channel
 * carries Derek's conversation; this thread carries the receipts.
 *
 * Created lazily on the first tool call of a run (see gateway.ts). Turns
 * with no tool calls never spawn a thread.
 */

const MAX_RESULT_BYTES = 1800; // leave slack under the 2000 Discord limit
const MAX_ARGS_BYTES = 1800;

export async function createDetailThread(
	_channel: TextChannel,
	triggerMessage: DiscordJsMessage,
	title: string,
): Promise<DetailThread> {
	const thread = await triggerMessage.startThread({
		name: `🔧 ${title.slice(0, 95)}`,
		autoArchiveDuration: 60,
	});
	return new DetailThread(thread);
}

export class DetailThread {
	private thread: ThreadChannel;
	/** Counter so successive tool calls are numbered inside the thread. */
	private toolIndex = 0;

	constructor(thread: ThreadChannel) {
		this.thread = thread;
	}

	getThread(): ThreadChannel {
		return this.thread;
	}

	/**
	 * Announce that a tool is about to run. Posts two messages: a header
	 * with the tool name and index, and the formatted args. The result
	 * gets posted separately via `recordResult` once the tool completes.
	 */
	async recordStart(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<void> {
		this.toolIndex++;
		const n = this.toolIndex;

		const header = `**${n}. 🔧 \`${toolName}\`**`;
		await this.thread.send(header).catch(() => {});

		const argsFormatted = formatArgs(args);
		if (argsFormatted) {
			await this.thread.send(argsFormatted).catch(() => {});
		}
	}

	/**
	 * Post the formatted result of the tool call that was just announced
	 * via `recordStart`. One message — the third in the triplet.
	 */
	async recordResult(
		toolName: string,
		result: string,
		isError: boolean,
	): Promise<void> {
		const icon = isError ? '❌' : '✅';
		const body = formatResultBody(result);
		await this.thread.send(`${icon} **${toolName}**\n${body}`).catch(() => {});
	}
}

/**
 * Format tool arguments as a fenced JSON block, truncated if necessary.
 * Returns empty string for arg-less tools.
 */
function formatArgs(args: Record<string, unknown>): string {
	if (!args || typeof args !== 'object') return '';
	const keys = Object.keys(args);
	if (keys.length === 0) return '';

	let json: string;
	try {
		json = JSON.stringify(args, null, 2);
	} catch {
		json = String(args);
	}

	if (json.length > MAX_ARGS_BYTES) {
		json = `${json.slice(0, MAX_ARGS_BYTES)}\n… (truncated)`;
	}
	return `\`\`\`json\n${json}\n\`\`\``;
}

/**
 * Format the result content as a code block, truncating and noting the
 * clip if the result is too large for a single Discord message.
 */
function formatResultBody(result: string): string {
	if (!result) return '*(no output)*';
	if (result.length <= MAX_RESULT_BYTES) {
		return `\`\`\`\n${result}\n\`\`\``;
	}
	return `\`\`\`\n${result.slice(0, MAX_RESULT_BYTES)}\n\`\`\`\n…(output truncated, ${result.length} chars total)`;
}

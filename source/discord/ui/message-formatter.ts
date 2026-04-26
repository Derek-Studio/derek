import type {ToolCall} from '@/types/core';

/**
 * Format a tool call as a Discord embed-style message.
 */
export function formatToolCall(toolCall: ToolCall): string {
	const name = toolCall.function.name;
	const args = toolCall.function.arguments;

	let argsPreview = '';
	if (typeof args === 'object' && args !== null) {
		const entries = Object.entries(args);
		if (entries.length > 0) {
			const lines = entries.map(([key, value]) => {
				const strVal =
					typeof value === 'string'
						? value.length > 100
							? value.slice(0, 100) + '…'
							: value
						: JSON.stringify(value);
				return `  ${key}: ${strVal}`;
			});
			argsPreview = '\n' + lines.join('\n');
		}
	}

	return `🔧 **${name}**${argsPreview}`;
}

/**
 * Format a tool result for display in a thread.
 */
export function formatToolResult(
	toolName: string,
	result: string,
	isError: boolean,
): string {
	const icon = isError ? '❌' : '✅';
	const truncated =
		result.length > 1500 ? result.slice(0, 1500) + '\n…(truncated)' : result;

	return `${icon} **${toolName}**\n\`\`\`\n${truncated}\n\`\`\``;
}

/**
 * Format a progress update.
 */
export function formatProgress(
	steps: Array<{label: string; status: string; detail?: string}>,
	title: string,
): string {
	const icons: Record<string, string> = {
		pending: '⬜',
		running: '🔄',
		complete: '✅',
		error: '❌',
	};

	const lines = steps.map(s => {
		const icon = icons[s.status] || '⬜';
		const detail = s.detail ? ` — ${s.detail}` : '';
		return `${icon} ${s.label}${detail}`;
	});

	return `**${title}**\n━━━━━━━━━━━━━━━━━━━━\n${lines.join('\n')}`;
}

/**
 * Format the "thinking" indicator message.
 */
export function formatThinking(): string {
	return '💭 Thinking...';
}

/**
 * Format tool approval request for Discord buttons.
 */
export function formatToolApproval(toolCall: ToolCall): string {
	const name = toolCall.function.name;
	const args = toolCall.function.arguments;

	let detail = '';
	if (typeof args === 'object' && args !== null) {
		// Show the most relevant arg for common tools
		if ('command' in args) {
			detail = `\n\`\`\`\n${String(args.command).slice(0, 500)}\n\`\`\``;
		} else if ('path' in args) {
			detail = `\nPath: \`${args.path}\``;
		} else {
			const preview = JSON.stringify(args, null, 2);
			if (preview.length < 500) {
				detail = `\n\`\`\`json\n${preview}\n\`\`\``;
			}
		}
	}

	return `🔧 **Tool: ${name}**${detail}`;
}

/**
 * Format session status information.
 */
const COMPACT_TOKEN_THRESHOLD = 670_000;
const HARD_CAP_TOKENS = 960_000;

export function formatSessionStatus(info: {
	model?: string;
	provider?: string;
	mode: string;
	messageCount: number;
	estimatedTokens?: number;
	workingDirectory: string;
	sessionId: string;
}): string {
	let contextLine = '';
	if (info.estimatedTokens !== undefined) {
		const t = info.estimatedTokens;
		const bar = buildTokenBar(t, HARD_CAP_TOKENS, 12);
		const pct = Math.round((t / HARD_CAP_TOKENS) * 100);
		const status =
			t >= HARD_CAP_TOKENS
				? '🔴 full'
				: t >= COMPACT_TOKEN_THRESHOLD
					? '🟡 compacting soon'
					: '🟢 ok';
		contextLine = `\n📊 Context: \`${bar}\` ${pct}% (~${Math.round(t / 1000)}k tokens) ${status}`;
	}

	const lines = [
		`**Session Status**`,
		`━━━━━━━━━━━━━━━━━━━━`,
		`📁 Working directory: \`${info.workingDirectory}\``,
		`🤖 Model: ${info.model || 'default'}`,
		`🔌 Provider: ${info.provider || 'default'}`,
		`⚡ Mode: ${info.mode}`,
		`💬 Messages: ${info.messageCount}${contextLine}`,
		`🆔 Session: \`${info.sessionId.slice(0, 8)}…\``,
	];
	return lines.join('\n');
}

function buildTokenBar(used: number, cap: number, width: number): string {
	const filled = Math.min(Math.round((used / cap) * width), width);
	return '█'.repeat(filled) + '░'.repeat(width - filled);
}

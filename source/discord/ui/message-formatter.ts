import type {ToolCall} from '@/types/core';

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

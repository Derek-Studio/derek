import type {LLMClient, Message} from '@/types/core';

// Rough chars-per-token estimate (works well for English/code)
const CHARS_PER_TOKEN = 4;

// Compact when history exceeds this many estimated tokens.
// Opus 4.7 / Opus 4.6 / Sonnet 4.6 all have 1M context windows.
// Leaves headroom for system prompt + tools (~30k) + response (~8k).
const COMPACT_TOKEN_THRESHOLD = 670_000;

// Max tokens for a single incoming user message before we truncate it.
const MAX_SINGLE_MESSAGE_TOKENS = 200_000;
const MAX_SINGLE_MESSAGE_CHARS = MAX_SINGLE_MESSAGE_TOKENS * CHARS_PER_TOKEN;

// How many recent messages to always keep intact after compaction.
const KEEP_RECENT = 15;

export interface CompactionResult {
	messages: Message[];
	compacted: boolean;
	method: 'llm' | 'truncation' | 'none';
	originalCount: number;
	estimatedTokens: number;
}

export function estimateTokens(messages: Message[]): number {
	return messages.reduce((sum, m) => {
		const text =
			typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
		return sum + Math.ceil(text.length / CHARS_PER_TOKEN);
	}, 0);
}

/**
 * Truncate a single message if it's unreasonably large.
 * Called before adding a user message to history.
 */
export function guardMessageSize(content: string): {
	content: string;
	truncated: boolean;
} {
	if (content.length <= MAX_SINGLE_MESSAGE_CHARS) {
		return {content, truncated: false};
	}
	const truncated = content.slice(0, MAX_SINGLE_MESSAGE_CHARS);
	console.warn(
		`[compaction] incoming message truncated from ${content.length} to ${MAX_SINGLE_MESSAGE_CHARS} chars (~${MAX_SINGLE_MESSAGE_TOKENS}k tokens)`,
	);
	return {
		content:
			truncated +
			`\n\n[Message truncated — original was ${Math.ceil(content.length / CHARS_PER_TOKEN).toLocaleString()} tokens, limit is ${MAX_SINGLE_MESSAGE_TOKENS.toLocaleString()} tokens]`,
		truncated: true,
	};
}

/**
 * Automatically compact message history when it approaches the token budget.
 *
 * 1. Tries LLM summarisation of older turns (keeps last KEEP_RECENT intact).
 * 2. Falls back to hard truncation if LLM fails — never silently passes an oversized history.
 */
export async function autoCompact(
	messages: Message[],
	client: LLMClient,
): Promise<CompactionResult> {
	const originalCount = messages.length;
	const estimatedTokens = estimateTokens(messages);

	if (estimatedTokens <= COMPACT_TOKEN_THRESHOLD) {
		return {
			messages,
			compacted: false,
			method: 'none',
			originalCount,
			estimatedTokens,
		};
	}

	console.log(
		`[compaction] ~${estimatedTokens.toLocaleString()} tokens (threshold ${COMPACT_TOKEN_THRESHOLD.toLocaleString()}) — attempting LLM summarisation`,
	);

	// ── LLM summarisation ──────────────────────────────────────────────────
	const toSummarize = messages.slice(0, originalCount - KEEP_RECENT);
	const recent = messages.slice(originalCount - KEEP_RECENT);

	const summaryContent = toSummarize
		.filter(m => m.role === 'user' || m.role === 'assistant')
		.map(m => {
			const label = m.role === 'assistant' ? 'Derek' : 'User';
			const text =
				typeof m.content === 'string'
					? m.content.slice(0, 600)
					: JSON.stringify(m.content).slice(0, 600);
			return `**${label}**: ${text}`;
		})
		.join('\n\n');

	const prompt = `Summarize this coding session history for an AI assistant that needs to continue working on it.

Be dense and specific. Include: what was asked, work done, files modified, errors resolved, decisions made, and the current state of the project. Omit pleasantries.

${summaryContent}`;

	try {
		const response = await client.chat(
			[{role: 'user', content: prompt}],
			{},
			{},
			undefined,
			undefined,
		);

		const summary = response.choices[0]?.message.content;
		if (summary) {
			const compactedMessages: Message[] = [
				{
					role: 'user',
					content: '[Summary of earlier conversation — pick up from here]',
				},
				{role: 'assistant', content: summary},
				...recent,
			];
			const newTokens = estimateTokens(compactedMessages);
			console.log(
				`[compaction] LLM summarisation: ${originalCount} messages / ~${estimatedTokens.toLocaleString()} tokens → ${compactedMessages.length} messages / ~${newTokens.toLocaleString()} tokens`,
			);
			return {
				messages: compactedMessages,
				compacted: true,
				method: 'llm',
				originalCount,
				estimatedTokens,
			};
		}
		console.warn(
			'[compaction] LLM returned empty summary — falling back to hard truncation',
		);
	} catch (err) {
		console.warn(
			`[compaction] LLM summarisation failed (${err instanceof Error ? err.message.slice(0, 120) : String(err)}) — falling back to hard truncation`,
		);
	}

	// ── Hard truncation fallback ───────────────────────────────────────────
	// Kick in whenever LLM fails OR the history exceeds the hard cap regardless.
	const keepCount = Math.min(KEEP_RECENT, originalCount);
	const kept = messages.slice(originalCount - keepCount);
	const dropped = originalCount - keepCount;
	const newTokens = estimateTokens(kept);
	console.warn(
		`[compaction] hard truncation: dropped ${dropped} messages, keeping last ${keepCount} (~${newTokens.toLocaleString()} tokens)`,
	);

	return {
		messages: [
			{
				role: 'user',
				content: `[${dropped} earlier messages were dropped — context was too large for LLM summarisation]`,
			},
			{
				role: 'assistant',
				content:
					"Understood — I've lost the earlier context but will continue from what's here.",
			},
			...kept,
		],
		compacted: true,
		method: 'truncation',
		originalCount,
		estimatedTokens,
	};
}

import type {LLMClient, Message} from '@/types/core';

const AUTO_COMPACT_THRESHOLD = 40;
const KEEP_RECENT = 15;

export interface CompactionResult {
	messages: Message[];
	compacted: boolean;
	originalCount: number;
}

/**
 * Automatically compact message history when it exceeds the threshold.
 *
 * Uses the LLM to summarize older turns into a dense context block, keeping
 * the most recent exchanges intact. Falls back silently to the original history
 * if the summarization call fails.
 */
export async function autoCompact(
	messages: Message[],
	client: LLMClient,
): Promise<CompactionResult> {
	const originalCount = messages.length;
	if (originalCount <= AUTO_COMPACT_THRESHOLD) {
		return {messages, compacted: false, originalCount};
	}

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
		if (!summary) return {messages, compacted: false, originalCount};

		return {
			messages: [
				{
					role: 'user',
					content: '[Summary of earlier conversation — pick up from here]',
				},
				{role: 'assistant', content: summary},
				...recent,
			],
			compacted: true,
			originalCount,
		};
	} catch {
		return {messages, compacted: false, originalCount};
	}
}

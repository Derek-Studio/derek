const DISCORD_MAX_LENGTH = 2000;
const CODE_BLOCK_FENCE = '```';

/**
 * Split a message into chunks that fit within Discord's 2000-char limit.
 * Tries to split at smart boundaries: code blocks, paragraphs, lines, words.
 */
export function splitMessage(content: string): string[] {
	if (content.length <= DISCORD_MAX_LENGTH) {
		return [content];
	}

	const chunks: string[] = [];
	let remaining = content;

	while (remaining.length > 0) {
		if (remaining.length <= DISCORD_MAX_LENGTH) {
			chunks.push(remaining);
			break;
		}

		const chunk = remaining.slice(0, DISCORD_MAX_LENGTH);
		let splitPoint = DISCORD_MAX_LENGTH;

		// Try to split at a code block boundary first
		const lastCodeFence = chunk.lastIndexOf(
			`\n${CODE_BLOCK_FENCE}`,
			DISCORD_MAX_LENGTH,
		);
		if (lastCodeFence > DISCORD_MAX_LENGTH / 2) {
			// Find the end of the code block line
			const endOfLine = chunk.indexOf('\n', lastCodeFence + 1);
			if (
				endOfLine !== -1 &&
				chunk.slice(lastCodeFence + 1).startsWith(CODE_BLOCK_FENCE)
			) {
				splitPoint = endOfLine + 1;
			}
		}

		// Try paragraph break
		if (splitPoint === DISCORD_MAX_LENGTH) {
			const lastParaBreak = chunk.lastIndexOf('\n\n');
			if (lastParaBreak > DISCORD_MAX_LENGTH / 3) {
				splitPoint = lastParaBreak + 2;
			}
		}

		// Try line break
		if (splitPoint === DISCORD_MAX_LENGTH) {
			const lastLineBreak = chunk.lastIndexOf('\n');
			if (lastLineBreak > DISCORD_MAX_LENGTH / 3) {
				splitPoint = lastLineBreak + 1;
			}
		}

		// Try word break
		if (splitPoint === DISCORD_MAX_LENGTH) {
			const lastSpace = chunk.lastIndexOf(' ');
			if (lastSpace > DISCORD_MAX_LENGTH / 3) {
				splitPoint = lastSpace + 1;
			}
		}

		chunks.push(remaining.slice(0, splitPoint));
		remaining = remaining.slice(splitPoint);
	}

	// Fix broken code blocks: if a chunk opens a code block without closing it,
	// close it and re-open in the next chunk
	for (let i = 0; i < chunks.length - 1; i++) {
		const fences = (chunks[i].match(/```/g) || []).length;
		if (fences % 2 !== 0) {
			// Odd number of fences = unclosed code block
			chunks[i] += '\n```';
			chunks[i + 1] = '```\n' + chunks[i + 1];
		}
	}

	return chunks.filter(c => c.trim().length > 0);
}

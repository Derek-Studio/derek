import {CHARS_PER_TOKEN_ESTIMATE} from '@/constants';

/**
 * Calculate estimated token count from text content.
 * Uses a simple approximation: characters / 4
 * This is a quick estimate used for UI display purposes.
 *
 * @param content - The text content to estimate tokens for
 * @returns Estimated token count
 */
export const calculateTokens = (content: string): number => {
	return Math.ceil(content.length / CHARS_PER_TOKEN_ESTIMATE);
};

import {RetryError} from 'ai';

/**
 * Extracts the root cause error from AI SDK error wrappers.
 * AI SDK wraps errors in RetryError which contains lastError.
 */
export function extractRootError(error: unknown): unknown {
	// Handle AI SDK RetryError - extract the last error
	if (RetryError.isInstance(error)) {
		if (error.lastError) {
			return extractRootError(error.lastError);
		}
	}
	return error;
}

import type {SecretScope} from './env-writer.js';
import type {SecretResolution} from './pending-store.js';

export interface SecretDispatchRequest {
	key: string;
	description: string;
	scope: SecretScope;
	projectDir?: string;
	filePath?: string; // When set, write content to this file instead of .env
	channelId: string;
	ttlMs?: number;
	signal?: AbortSignal;
}

type SecretDispatchHandler = (
	request: SecretDispatchRequest,
) => Promise<SecretResolution>;

let handler: SecretDispatchHandler | null = null;

export function setSecretDispatchHandler(h: SecretDispatchHandler): void {
	handler = h;
}

export function hasSecretDispatchHandler(): boolean {
	return handler !== null;
}

export async function dispatchSecretRequest(
	request: SecretDispatchRequest,
): Promise<SecretResolution> {
	if (!handler) {
		return {status: 'error', reason: 'No secret dispatch handler registered'};
	}
	return handler(request);
}

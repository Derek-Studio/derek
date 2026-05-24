export interface ShareDispatchRequest {
	key: string;
	value: string;
	channelId: string;
	ttlMs?: number;
	signal?: AbortSignal;
}

export type ShareResolution =
	| {status: 'posted'; url: string}
	| {status: 'error'; reason: string};

type ShareDispatchHandler = (
	request: ShareDispatchRequest,
) => Promise<ShareResolution>;

let handler: ShareDispatchHandler | null = null;

export function setShareDispatchHandler(h: ShareDispatchHandler): void {
	handler = h;
}

export function hasShareDispatchHandler(): boolean {
	return handler !== null;
}

export async function dispatchShareRequest(
	request: ShareDispatchRequest,
): Promise<ShareResolution> {
	if (!handler) {
		return {status: 'error', reason: 'No share dispatch handler registered'};
	}
	return handler(request);
}

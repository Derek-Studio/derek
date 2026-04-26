import {AsyncLocalStorage} from 'node:async_hooks';

export interface ChannelContext {
	channelId: string;
	workingDirectory: string;
	signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<ChannelContext>();

export function withChannelContext<T>(
	ctx: ChannelContext,
	fn: () => Promise<T>,
): Promise<T> {
	return storage.run(ctx, fn);
}

export function getChannelContext(): ChannelContext | undefined {
	return storage.getStore();
}

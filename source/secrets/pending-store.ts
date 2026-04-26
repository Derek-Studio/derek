import {randomUUID} from 'node:crypto';
import type {SecretScope} from './env-writer.js';

export type SecretResolution =
	| {status: 'stored'; path: string; action: 'created' | 'updated'}
	| {status: 'expired'}
	| {status: 'cancelled'; reason?: string}
	| {status: 'denied'; reason: string}
	| {status: 'error'; reason: string};

export interface PendingSecretEntry {
	id: string;
	key: string;
	description: string;
	scope: SecretScope;
	projectDir?: string;
	filePath?: string; // When set, write content to this file instead of .env
	channelId: string;
	expiresAt: number;
	resolve: (resolution: SecretResolution) => void;
}

interface CreateEntryOpts {
	key: string;
	description: string;
	scope: SecretScope;
	projectDir?: string;
	filePath?: string;
	channelId: string;
	ttlMs: number;
	resolve: (resolution: SecretResolution) => void;
}

class PendingSecretStore {
	private entries = new Map<string, PendingSecretEntry>();

	create(opts: CreateEntryOpts): PendingSecretEntry {
		const id = randomUUID();
		const entry: PendingSecretEntry = {
			id,
			key: opts.key,
			description: opts.description,
			scope: opts.scope,
			projectDir: opts.projectDir,
			filePath: opts.filePath,
			channelId: opts.channelId,
			expiresAt: Date.now() + opts.ttlMs,
			resolve: opts.resolve,
		};
		this.entries.set(id, entry);

		setTimeout(() => {
			if (this.entries.has(id)) {
				this.entries.delete(id);
				opts.resolve({status: 'expired'});
			}
		}, opts.ttlMs);

		return entry;
	}

	get(id: string): PendingSecretEntry | undefined {
		return this.entries.get(id);
	}

	consume(id: string): PendingSecretEntry | undefined {
		const entry = this.entries.get(id);
		this.entries.delete(id);
		return entry;
	}

	cancel(id: string, reason?: string): void {
		const entry = this.entries.get(id);
		if (entry) {
			this.entries.delete(id);
			entry.resolve({status: 'cancelled', reason});
		}
	}
}

export const pendingSecretStore = new PendingSecretStore();

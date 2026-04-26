import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {getAppDataPath} from '@/config/paths';
import type {DiscordDevelopmentMode, DiscordSessionData} from '../types.js';

const MAPPING_FILE = 'discord-sessions.json';

/**
 * Maps Discord channel/thread IDs to Derek sessions.
 * Persists the mapping to disk so sessions survive bot restarts.
 */
export class DiscordSessionStore {
	private sessions: Map<string, DiscordSessionData> = new Map();
	private storePath!: string;
	private initialized = false;
	private writeLock: Promise<void> = Promise.resolve();

	async initialize(): Promise<void> {
		if (this.initialized) return;

		const dataDir = path.join(getAppDataPath(), 'discord');
		await fs.mkdir(dataDir, {recursive: true});
		this.storePath = path.join(dataDir, MAPPING_FILE);

		try {
			const data = await fs.readFile(this.storePath, 'utf-8');
			const parsed = JSON.parse(data);
			if (Array.isArray(parsed)) {
				for (const entry of parsed) {
					if (entry.conversationId) {
						this.sessions.set(entry.conversationId, entry);
					}
				}
			}
		} catch {
			// File doesn't exist or is corrupt — start fresh
		}

		this.initialized = true;
	}

	/**
	 * Derive a stable conversation ID from a Discord channel/thread.
	 */
	static conversationId(channelId: string, guildId?: string): string {
		if (guildId) {
			return `discord:guild:${guildId}:channel:${channelId}`;
		}
		return `discord:dm:${channelId}`;
	}

	getSession(conversationId: string): DiscordSessionData | undefined {
		return this.sessions.get(conversationId);
	}

	async createSession(opts: {
		channelId: string;
		guildId?: string;
		workingDirectory: string;
		model?: string;
		provider?: string;
		mode?: DiscordDevelopmentMode;
	}): Promise<DiscordSessionData> {
		const conversationId = DiscordSessionStore.conversationId(
			opts.channelId,
			opts.guildId,
		);
		const now = new Date().toISOString();

		const session: DiscordSessionData = {
			sessionId: crypto.randomUUID(),
			channelId: opts.channelId,
			guildId: opts.guildId,
			conversationId,
			workingDirectory: opts.workingDirectory,
			model: opts.model,
			provider: opts.provider,
			mode: opts.mode ?? 'auto-accept',
			createdAt: now,
			lastActiveAt: now,
		};

		this.sessions.set(conversationId, session);
		await this.persist();
		return session;
	}

	async updateSession(
		conversationId: string,
		updates: Partial<
			Pick<
				DiscordSessionData,
				| 'model'
				| 'provider'
				| 'mode'
				| 'workingDirectory'
				| 'lastProcessedMessageId'
			>
		>,
	): Promise<DiscordSessionData | null> {
		const session = this.sessions.get(conversationId);
		if (!session) return null;

		Object.assign(session, updates, {lastActiveAt: new Date().toISOString()});
		await this.persist();
		return session;
	}

	async touchSession(conversationId: string): Promise<void> {
		const session = this.sessions.get(conversationId);
		if (session) {
			session.lastActiveAt = new Date().toISOString();
			await this.persist();
		}
	}

	async deleteSession(conversationId: string): Promise<void> {
		this.sessions.delete(conversationId);
		await this.persist();
	}

	listSessions(): DiscordSessionData[] {
		return Array.from(this.sessions.values()).sort(
			(a, b) =>
				new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime(),
		);
	}

	/**
	 * Fork a session: create a new session for a thread with copied metadata.
	 */
	async forkSession(
		parentConversationId: string,
		threadChannelId: string,
		guildId?: string,
	): Promise<DiscordSessionData | null> {
		const parent = this.sessions.get(parentConversationId);
		if (!parent) return null;

		return this.createSession({
			channelId: threadChannelId,
			guildId,
			workingDirectory: parent.workingDirectory,
			model: parent.model,
			provider: parent.provider,
			mode: parent.mode,
		});
	}

	private async persist(): Promise<void> {
		const prev = this.writeLock;
		let release!: () => void;
		this.writeLock = new Promise<void>(r => {
			release = r;
		});
		await prev;
		try {
			const data = JSON.stringify(Array.from(this.sessions.values()), null, 2);
			const tmpPath = `${this.storePath}.${crypto.randomUUID()}.tmp`;
			await fs.writeFile(tmpPath, data, {mode: 0o600});
			await fs.rename(tmpPath, this.storePath);
		} finally {
			release();
		}
	}
}

export const discordSessionStore = new DiscordSessionStore();

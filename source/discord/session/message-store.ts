import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {getAppDataPath} from '@/config/paths';
import type {Message} from '@/types/core';

const MAX_MESSAGES = 500;

/**
 * Simple file-based message store for Discord conversations.
 * Each conversation gets its own JSON file keyed by conversationId.
 */
export class MessageStore {
	private storeDir!: string;
	private cache: Map<string, Message[]> = new Map();
	private initialized = false;

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.storeDir = path.join(getAppDataPath(), 'discord', 'conversations');
		await fs.mkdir(this.storeDir, {recursive: true});
		this.initialized = true;
	}

	private filePath(conversationId: string): string {
		// Hash the conversationId to get a safe filename
		const hash = crypto
			.createHash('sha256')
			.update(conversationId)
			.digest('hex')
			.slice(0, 16);
		return path.join(this.storeDir, `${hash}.json`);
	}

	async getMessages(conversationId: string): Promise<Message[]> {
		const cached = this.cache.get(conversationId);
		if (cached) return cached;

		try {
			const data = await fs.readFile(this.filePath(conversationId), 'utf-8');
			const messages = JSON.parse(data) as Message[];
			this.cache.set(conversationId, messages);
			return messages;
		} catch {
			return [];
		}
	}

	async saveMessages(
		conversationId: string,
		messages: Message[],
	): Promise<void> {
		// Truncate if too long
		const truncated =
			messages.length > MAX_MESSAGES
				? messages.slice(messages.length - MAX_MESSAGES)
				: messages;

		this.cache.set(conversationId, truncated);

		const filePath = this.filePath(conversationId);
		const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
		await fs.writeFile(tmpPath, JSON.stringify(truncated, null, 2), {
			mode: 0o600,
		});
		await fs.rename(tmpPath, filePath);
	}

	async appendMessage(
		conversationId: string,
		message: Message,
	): Promise<Message[]> {
		const messages = await this.getMessages(conversationId);
		messages.push(message);
		await this.saveMessages(conversationId, messages);
		return messages;
	}

	async appendMessages(
		conversationId: string,
		newMessages: Message[],
	): Promise<Message[]> {
		const messages = await this.getMessages(conversationId);
		messages.push(...newMessages);
		await this.saveMessages(conversationId, messages);
		return messages;
	}

	async clearMessages(conversationId: string): Promise<void> {
		this.cache.delete(conversationId);
		try {
			await fs.unlink(this.filePath(conversationId));
		} catch {
			// Ignore if file doesn't exist
		}
	}
}

export const messageStore = new MessageStore();

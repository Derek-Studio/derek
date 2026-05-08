import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import {getAppDataPath} from '@/config/paths';
import {
	type ActivityEntry,
	type ChecklistItem,
	isTerminal,
	MAX_ACTIVITY_ENTRIES,
	type TaskRecord,
	type TaskStatus,
} from './task-types.js';

const STORE_FILENAME = 'tasks.json';

/**
 * Records are persisted; AbortController lives only in memory (can't survive
 * a restart — any `running` task at startup is marked `failed`).
 */
interface RuntimeState {
	abortController: AbortController;
}

/**
 * Events emitted by the store:
 *   - `change`: any persisted field changed (status, checklist, activity, etc.)
 *     Listeners receive the updated record and the previous status.
 *   - `terminal`: emitted once when a task transitions to a terminal state.
 *
 * Used by `task_wait` and the status-change notifier.
 */
interface StoreEvents {
	change: [task: TaskRecord, prevStatus: TaskStatus];
	terminal: [task: TaskRecord];
}

export class TaskStore extends EventEmitter<StoreEvents> {
	private tasks = new Map<string, TaskRecord>();
	private runtime = new Map<string, RuntimeState>();
	private storePath!: string;
	private initialized = false;
	private writeLock: Promise<void> = Promise.resolve();

	async initialize(): Promise<void> {
		if (this.initialized) return;

		const dataDir = path.join(getAppDataPath(), 'discord');
		await fs.mkdir(dataDir, {recursive: true});
		this.storePath = path.join(dataDir, STORE_FILENAME);

		try {
			const data = await fs.readFile(this.storePath, 'utf-8');
			const parsed = JSON.parse(data);
			if (Array.isArray(parsed)) {
				for (const raw of parsed as Array<Record<string, unknown>>) {
					const entry = raw as unknown as TaskRecord & {
						threadId?: string | null;
						headerMessageId?: string | null;
					};
					if (!entry.id) continue;

					// v2 → v3 migration: threadId/headerMessageId became
					// statusChannelId/statusMessageId. Either field set means
					// "this came from before the refactor" — best-effort copy.
					if (entry.statusChannelId === undefined) {
						entry.statusChannelId = entry.threadId ?? null;
					}
					if (entry.statusMessageId === undefined) {
						entry.statusMessageId = entry.headerMessageId ?? null;
					}
					delete entry.threadId;
					delete entry.headerMessageId;

					// Any task that was mid-flight when the bot stopped is dead.
					// Record the fact so the agent can see it happened.
					if (entry.status === 'running' || entry.status === 'pending') {
						entry.status = 'failed';
						entry.error = 'Bot restarted before task completed';
						entry.endedAt = entry.endedAt ?? Date.now();
					}
					this.tasks.set(entry.id, entry);
				}
			}
		} catch {
			// No existing store — start fresh
		}

		this.initialized = true;

		// Persist restart-cleanup changes.
		if (this.tasks.size > 0) {
			await this.persist();
		}
	}

	/** Create a new task record with status=pending. */
	create(opts: {
		parentChannelId: string;
		parentGuildId?: string;
		parentConversationId: string;
		conversationId: string;
		workingDirectory: string;
		worktreePath: string;
		branch: string;
		title: string;
		initialPrompt: string;
	}): TaskRecord {
		const id = shortId();
		const now = Date.now();
		const task: TaskRecord = {
			id,
			parentChannelId: opts.parentChannelId,
			parentGuildId: opts.parentGuildId,
			parentConversationId: opts.parentConversationId,
			statusChannelId: null,
			statusMessageId: null,
			conversationId: opts.conversationId,
			workingDirectory: opts.workingDirectory,
			worktreePath: opts.worktreePath,
			branch: opts.branch,
			title: opts.title,
			initialPrompt: opts.initialPrompt,
			status: 'pending',
			checklist: [],
			toolCallCount: 0,
			startedAt: now,
			endedAt: null,
			error: null,
			acknowledgedAt: null,
			activity: [],
			lastResponse: null,
		};
		this.tasks.set(id, task);
		this.runtime.set(id, {abortController: new AbortController()});
		void this.persist();
		this.emit('change', task, 'pending');
		return task;
	}

	get(id: string): TaskRecord | undefined {
		return this.tasks.get(id);
	}

	getAbortController(id: string): AbortController | undefined {
		return this.runtime.get(id)?.abortController;
	}

	/** List tasks for a given channel. */
	listForChannel(channelId: string): TaskRecord[] {
		return [...this.tasks.values()]
			.filter(t => t.parentChannelId === channelId)
			.sort((a, b) => b.startedAt - a.startedAt);
	}

	/** Tasks in this channel that are still running or pending. */
	listActiveForChannel(channelId: string): TaskRecord[] {
		return this.listForChannel(channelId).filter(t => !isTerminal(t.status));
	}

	/**
	 * Tasks that terminated since the given timestamp and haven't been
	 * acknowledged to the agent yet. Used by the ACTIVE TASKS auto-injector.
	 */
	listUnacknowledgedTerminalForChannel(
		channelId: string,
		since: number,
	): TaskRecord[] {
		return this.listForChannel(channelId).filter(
			t =>
				isTerminal(t.status) &&
				t.acknowledgedAt === null &&
				(t.endedAt ?? 0) >= since,
		);
	}

	/** Mark a set of tasks as acknowledged (shown to agent). */
	async acknowledge(ids: string[]): Promise<void> {
		const now = Date.now();
		let changed = false;
		for (const id of ids) {
			const task = this.tasks.get(id);
			if (task && task.acknowledgedAt === null) {
				task.acknowledgedAt = now;
				changed = true;
			}
		}
		if (changed) await this.persist();
	}

	/**
	 * Mutate a task with a partial update, persist, and fire events.
	 * Pass null/undefined fields through unchanged.
	 */
	async update(
		id: string,
		patch: Partial<Omit<TaskRecord, 'id'>>,
	): Promise<TaskRecord | null> {
		const task = this.tasks.get(id);
		if (!task) return null;
		const prevStatus = task.status;
		Object.assign(task, patch);
		// Terminal transition → drop the AbortController (no longer needed).
		if (isTerminal(task.status)) {
			this.runtime.delete(id);
			if (task.endedAt === null) task.endedAt = Date.now();
		}
		await this.persist();
		this.emit('change', task, prevStatus);
		if (prevStatus !== task.status && isTerminal(task.status)) {
			this.emit('terminal', task);
		}
		return task;
	}

	/** Append an activity entry (bounded log). */
	async appendActivity(id: string, entry: ActivityEntry): Promise<void> {
		const task = this.tasks.get(id);
		if (!task) return;
		task.activity.push(entry);
		if (task.activity.length > MAX_ACTIVITY_ENTRIES) {
			task.activity.splice(0, task.activity.length - MAX_ACTIVITY_ENTRIES);
		}
		// Don't emit 'change' for every activity append — would be noisy.
		// Callers that care update status or checklist explicitly.
		await this.persist();
	}

	async setChecklist(id: string, checklist: ChecklistItem[]): Promise<void> {
		const task = this.tasks.get(id);
		if (!task) return;
		task.checklist = checklist;
		await this.persist();
		this.emit('change', task, task.status);
	}

	async incrementToolCount(id: string): Promise<void> {
		const task = this.tasks.get(id);
		if (!task) return;
		task.toolCallCount++;
		// No persist every tick — this one is cheap enough to persist on change.
		await this.persist();
	}

	/**
	 * Wait for a task to reach a terminal state. Resolves with the task on
	 * terminal, or throws on timeout.
	 */
	async waitForTerminal(id: string, timeoutMs: number): Promise<TaskRecord> {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Task ${id} not found`);
		if (isTerminal(task.status)) return task;

		return new Promise<TaskRecord>((resolve, reject) => {
			const onTerminal = (t: TaskRecord) => {
				if (t.id !== id) return;
				cleanup();
				resolve(t);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for task ${id}`));
			}, timeoutMs);
			const cleanup = () => {
				this.off('terminal', onTerminal);
				clearTimeout(timer);
			};
			this.on('terminal', onTerminal);
		});
	}

	private async persist(): Promise<void> {
		// Serialise writes: every persist waits for the previous one.
		const prev = this.writeLock;
		let release!: () => void;
		this.writeLock = new Promise<void>(r => {
			release = r;
		});
		await prev;
		try {
			const data = JSON.stringify([...this.tasks.values()], null, 2);
			const tmpPath = `${this.storePath}.${crypto.randomUUID()}.tmp`;
			await fs.writeFile(tmpPath, data, {mode: 0o600});
			await fs.rename(tmpPath, this.storePath);
		} finally {
			release();
		}
	}
}

function shortId(): string {
	// 6 hex chars — enough uniqueness for per-channel task ids, short to type.
	return crypto.randomBytes(3).toString('hex');
}

export const taskStore = new TaskStore();

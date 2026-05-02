import type {
	Client,
	Message as DiscordJsMessage,
	TextChannel,
	ThreadChannel,
} from 'discord.js';
import type {Message} from '@/types/core';
import type {HeadlessRuntime} from '../runtime/headless-runtime.js';
import {
	DiscordSessionStore,
	discordSessionStore,
} from '../session/discord-session.js';
import {messageStore} from '../session/message-store.js';
import {withCurrentTask} from './task-invocation-context.js';
import {taskStore} from './task-store.js';
import {postParentNotification, TaskThread} from './task-thread.js';
import {
	isTerminal,
	MAX_CONCURRENT_TASKS_PER_CHANNEL,
	type TaskRecord,
} from './task-types.js';

/**
 * Tools the main agent can use to manage tasks. These are removed from the
 * toolset registered into a task's own `processMessage` call so tasks can't
 * spawn sub-tasks. (`task_checklist` is not in this list — tasks can use it.)
 */
export const TASK_MANAGEMENT_TOOL_NAMES = [
	'task_start',
	'task_status',
	'task_interrupt',
	'task_continue',
	'task_wait',
];

/**
 * Tools to remove from the *main channel* toolset. `task_checklist` is
 * meaningful only inside a task — leaking it to the main channel would
 * be confusing.
 */
export const MAIN_CHANNEL_EXCLUDED_TASK_TOOLS = ['task_checklist'];

/**
 * Cache of the Discord client + parent trigger message, so any task tool
 * called from any channel can resolve the bits it needs to start/continue
 * a task. Set once by the gateway when the runtime is wired up.
 */
let runtimeRef: HeadlessRuntime | null = null;
let clientRef: Client | null = null;

export function bindTaskRuntime(
	client: Client,
	runtime: HeadlessRuntime,
): void {
	clientRef = client;
	runtimeRef = runtime;
}

export function getBoundClient(): Client | null {
	return clientRef;
}

export function getBoundRuntime(): HeadlessRuntime | null {
	return runtimeRef;
}

export interface StartTaskOptions {
	parentChannelId: string;
	parentGuildId?: string;
	/** Discord message under which the task thread will be created. */
	parentTriggerMessage: DiscordJsMessage;
	title: string;
	prompt: string;
}

/**
 * Start a new task: create the thread, fork the session, kick off the
 * runtime in the background. Returns the task record immediately
 * (status=running by the time we return — the runtime continues in the
 * background).
 */
export async function startTask(opts: StartTaskOptions): Promise<TaskRecord> {
	const runtime = runtimeRef;
	if (!runtime) {
		throw new Error('Task runtime not bound — call bindTaskRuntime first');
	}

	// Concurrency cap.
	const active = taskStore.listActiveForChannel(opts.parentChannelId);
	if (active.length >= MAX_CONCURRENT_TASKS_PER_CHANNEL) {
		throw new Error(
			`Channel already has ${active.length} active task(s) (cap ${MAX_CONCURRENT_TASKS_PER_CHANNEL}). Interrupt or wait for one to finish before starting another.`,
		);
	}

	const parentConversationId = DiscordSessionStore.conversationId(
		opts.parentChannelId,
		opts.parentGuildId,
	);
	const parentSession = discordSessionStore.getSession(parentConversationId);
	if (!parentSession) {
		throw new Error(
			'No active session in parent channel — send a regular message in the channel first to establish one.',
		);
	}

	// Create the task record (pending).
	const task = taskStore.create({
		parentChannelId: opts.parentChannelId,
		parentGuildId: opts.parentGuildId,
		parentConversationId,
		// Use a synthetic conversationId for the task's own message history.
		conversationId: `task:${parentConversationId}:${Date.now()}`,
		workingDirectory: parentSession.workingDirectory,
		title: opts.title,
		initialPrompt: opts.prompt,
	});

	// Open the Discord thread (lazy create only when we know we're going to run).
	const taskThread = await TaskThread.create(opts.parentTriggerMessage, task);
	if (!taskThread) {
		await taskStore.update(task.id, {
			status: 'failed',
			error: 'Could not create Discord thread for task',
		});
		throw new Error('Failed to create Discord thread for task');
	}

	await taskStore.update(task.id, {
		threadId: taskThread.getThreadId(),
		headerMessageId: taskThread.getHeaderMessageId(),
		status: 'running',
	});
	taskThread.updateTask(taskStore.get(task.id)!);

	// Fire-and-forget: drive the runtime in the background.
	void driveTask(task.id, opts.prompt, taskThread, runtime).catch(err => {
		console.error(`[task ${task.id}] driver crashed:`, err);
		void finalizeTask(
			task.id,
			'failed',
			err instanceof Error ? err.message : String(err),
			taskThread,
		);
	});

	return taskStore.get(task.id) ?? task;
}

/**
 * Interrupt a running task. Aborts the runtime; the driver will catch
 * the cancellation and transition to `cancelled`.
 */
export async function interruptTask(
	taskId: string,
	reason?: string,
): Promise<TaskRecord | null> {
	const task = taskStore.get(taskId);
	if (!task) return null;
	if (isTerminal(task.status)) return task;

	const ctrl = taskStore.getAbortController(taskId);
	if (ctrl) {
		ctrl.abort(reason ?? 'interrupted');
	}
	// The driver's catch-cancellation block will transition status; we don't
	// double-write here.
	return task;
}

/**
 * Continue an interrupted/completed task with new instructions. Re-uses
 * the same conversationId so prior history is preserved.
 */
export async function continueTask(
	taskId: string,
	prompt: string,
): Promise<TaskRecord> {
	const runtime = runtimeRef;
	if (!runtime) {
		throw new Error('Task runtime not bound');
	}
	const task = taskStore.get(taskId);
	if (!task) throw new Error(`Task ${taskId} not found`);
	if (!isTerminal(task.status) && task.status !== 'pending') {
		throw new Error(
			`Task ${taskId} is currently ${task.status}; interrupt it before continuing.`,
		);
	}
	if (!task.threadId) {
		throw new Error(`Task ${taskId} has no Discord thread to continue in.`);
	}

	// Fetch the existing thread.
	const client = clientRef;
	if (!client) throw new Error('Discord client not bound');
	const channel = await client.channels.fetch(task.threadId);
	if (!channel || !('send' in channel) || !('isThread' in channel)) {
		throw new Error(`Task ${taskId} thread is no longer accessible.`);
	}
	const thread = channel as ThreadChannel;

	// Reset abort controller; status pending → running.
	// (taskStore.create sets one, but it was consumed by the previous run.)
	(
		taskStore as unknown as {
			runtime: Map<string, {abortController: AbortController}>;
		}
	).runtime.set(taskId, {abortController: new AbortController()});

	await taskStore.update(taskId, {
		status: 'running',
		error: null,
		endedAt: null,
		acknowledgedAt: null,
	});

	const updatedTask = taskStore.get(taskId)!;

	// Reconstruct a TaskThread wrapper around the existing thread + header.
	const headerMsg = task.headerMessageId
		? await thread.messages.fetch(task.headerMessageId).catch(() => null)
		: null;
	if (!headerMsg) {
		// Header gone — best effort: post a fresh status line.
		await thread
			.send('▶ Continuing task with new instructions…')
			.catch(() => {});
	}

	const taskThread = TaskThread.reattach(thread, updatedTask, headerMsg);

	await thread
		.send(`▶ Continuing with new instructions: ${truncate(prompt, 200)}`)
		.catch(() => {});

	void driveTask(
		taskId,
		prompt,
		taskThread,
		runtime,
		/* skipUserMessage */ false,
	).catch(err => {
		console.error(`[task ${taskId}] continuation crashed:`, err);
		void finalizeTask(
			taskId,
			'failed',
			err instanceof Error ? err.message : String(err),
			taskThread,
		);
	});

	return taskStore.get(taskId) ?? updatedTask;
}

/**
 * Drive a single processMessage round for a task. Wires runtime callbacks
 * into the TaskThread, persists the message history, manages activity log,
 * and handles terminal-state notification.
 */
async function driveTask(
	taskId: string,
	prompt: string,
	taskThread: TaskThread,
	runtime: HeadlessRuntime,
	skipUserMessage = false,
): Promise<void> {
	const task = taskStore.get(taskId);
	if (!task) return;

	const signal = taskStore.getAbortController(taskId)?.signal;

	// Load existing history (for continuations) or start empty.
	const history: Message[] = await messageStore.getMessages(
		task.conversationId,
	);

	try {
		const result = await withCurrentTask(taskId, () =>
			runtime.processMessage(
				history,
				prompt,
				'auto-accept', // tasks never block on approval prompts
				{
					onToken: (token: string) => {
						void taskThread.onToken(token);
					},
					// Should never be called in auto-accept mode, but if a tool's
					// needsApproval returns true unconditionally, default to approve.
					onToolApproval: async () => 'approve',
					onToolStart: (toolName: string, args: Record<string, unknown>) => {
						void taskStore.incrementToolCount(taskId);
						void taskStore.appendActivity(taskId, {
							timestampMs: Date.now(),
							kind: 'tool',
							summary: summariseTool(toolName, args),
						});
						void taskThread.recordToolStart(toolName, args);
						// Refresh header to bump tool count.
						const t = taskStore.get(taskId);
						if (t) taskThread.updateTask(t);
					},
					onToolResult: (
						toolName: string,
						output: string,
						isError: boolean,
					) => {
						void taskThread.recordToolResult(toolName, output, isError);
						if (isError) {
							void taskStore.appendActivity(taskId, {
								timestampMs: Date.now(),
								kind: 'error',
								summary: `${toolName}: ${truncate(output, 180)}`,
							});
						}
					},
				},
				signal,
				undefined,
				{
					excludeTools: TASK_MANAGEMENT_TOOL_NAMES,
					skipUserMessage,
				},
			),
		);

		// Persist the full history.
		await messageStore.saveMessages(task.conversationId, result.messages);

		// Record the assistant's final response and finalize as succeeded.
		await taskStore.appendActivity(taskId, {
			timestampMs: Date.now(),
			kind: 'assistant',
			summary: truncate(result.response || '(no output)', 180),
		});
		await finalizeTask(
			taskId,
			'succeeded',
			null,
			taskThread,
			result.response || '',
		);
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		const cancelled =
			signal?.aborted ||
			errMsg.toLowerCase().includes('cancelled') ||
			errMsg.toLowerCase().includes('aborted');

		// Persist whatever history we accumulated even on failure.
		await messageStore
			.saveMessages(task.conversationId, history)
			.catch(() => {});

		await finalizeTask(
			taskId,
			cancelled ? 'cancelled' : 'failed',
			cancelled
				? typeof signal?.reason === 'string'
					? signal.reason
					: 'cancelled'
				: errMsg,
			taskThread,
		);
	}
}

async function finalizeTask(
	taskId: string,
	status: 'succeeded' | 'failed' | 'cancelled',
	error: string | null,
	taskThread: TaskThread,
	lastResponse?: string,
): Promise<void> {
	const updated = await taskStore.update(taskId, {
		status,
		error,
		lastResponse: lastResponse ?? null,
	});
	if (!updated) return;

	await taskThread.postTerminalBanner(updated);

	// Notify the parent channel.
	const client = clientRef;
	if (!client) return;
	try {
		const parent = await client.channels.fetch(updated.parentChannelId);
		if (parent && 'send' in parent) {
			const thread = taskThread.getThread();
			await postParentNotification(
				parent as TextChannel | ThreadChannel,
				updated,
				thread,
			);
		}
	} catch {
		// Parent channel gone — non-fatal.
	}
}

function summariseTool(
	toolName: string,
	args: Record<string, unknown>,
): string {
	if (!args || typeof args !== 'object') return toolName;
	for (const key of ['path', 'file_path', 'command', 'query', 'url', 'name']) {
		if (key in args) {
			const v = args[key];
			if (typeof v === 'string' && v.length > 0) {
				return `${toolName}: ${truncate(v, 140)}`;
			}
		}
	}
	return toolName;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}

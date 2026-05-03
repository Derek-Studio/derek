import {AsyncLocalStorage} from 'node:async_hooks';
import type {Message as DiscordJsMessage} from 'discord.js';

/**
 * Per-turn invocation context for task tools.
 *
 * When the gateway starts a main-channel `processMessage` call, it wraps
 * the call in `withTaskInvocationContext(...)`. Task tools (task_start in
 * particular) then read this context to resolve:
 *   - which parent channel the invoking turn belongs to
 *   - which Discord message to anchor a new task thread off
 *
 * If a tool is called outside of a turn (e.g. from the CLI, or from
 * within a task's own runtime), the context is empty and the tool
 * returns a descriptive error instead of doing something unsafe.
 */
export interface TaskInvocationContext {
	parentChannelId: string;
	parentGuildId?: string;
	parentTriggerMessage: DiscordJsMessage;
}

const storage = new AsyncLocalStorage<TaskInvocationContext>();

export function withTaskInvocationContext<T>(
	ctx: TaskInvocationContext,
	fn: () => T,
): T {
	return storage.run(ctx, fn);
}

export function getTaskInvocationContext(): TaskInvocationContext | undefined {
	return storage.getStore();
}

/**
 * Separate ALS that identifies which task is currently being executed
 * inside a task runtime call. Set by task-runner.driveTask so the
 * `task_checklist` tool knows which task it's updating.
 */
const currentTaskStorage = new AsyncLocalStorage<{taskId: string}>();

export function withCurrentTask<T>(taskId: string, fn: () => T): T {
	return currentTaskStorage.run({taskId}, fn);
}

export function getCurrentTaskId(): string | undefined {
	return currentTaskStorage.getStore()?.taskId;
}

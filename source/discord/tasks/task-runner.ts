import path from 'node:path';
import type {
	Client,
	Message as DiscordJsMessage,
	TextChannel,
	ThreadChannel,
} from 'discord.js';
import {withChannelContext} from '@/secrets/active-context.js';
import type {Message} from '@/types/core';
import type {HeadlessRuntime} from '../runtime/headless-runtime.js';
import {
	DiscordSessionStore,
	discordSessionStore,
} from '../session/discord-session.js';
import {messageStore} from '../session/message-store.js';
import {withCurrentTask} from './task-invocation-context.js';
import {TaskStatusMessage} from './task-status-message.js';
import {taskStore} from './task-store.js';
import {
	isTerminal,
	MAX_CONCURRENT_TASKS_PER_CHANNEL,
	type TaskRecord,
} from './task-types.js';
import {
	createWorktreeForTask,
	findRepoRoot,
	removeWorktreeForTask,
} from './worktree-manager.js';

/**
 * Base branch new task worktrees are cut from. Hardcoded for v1 — the
 * design doc defers per-project / per-AGENTS.md configuration to a
 * follow-up. Every self-modifying project in this environment uses
 * `dev` as its working branch, so this is the right default.
 */
const TASK_BASE_BRANCH = 'dev';

type Sendable = TextChannel | ThreadChannel;

/**
 * Tools the main agent can use to manage tasks. These are removed from
 * the toolset registered into a task's own `processMessage` call so tasks
 * can't spawn sub-tasks. (`task_checklist` is not in this list — tasks
 * can use it.)
 */
export const TASK_MANAGEMENT_TOOL_NAMES = [
	'task_start',
	'task_status',
	'task_output',
	'task_interrupt',
	'task_continue',
	'task_wait',
];

/**
 * Tools to remove from the *main channel* toolset. `task_checklist` is
 * meaningful only inside a task.
 */
export const MAIN_CHANNEL_EXCLUDED_TASK_TOOLS = ['task_checklist'];

/**
 * Runtime + client references set once by the gateway at setup time so
 * every task tool can resolve the bits it needs without threading them
 * through every invocation.
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
	/**
	 * Discord message whose channel we post the status message into.
	 * Usually the message that triggered the main-channel turn.
	 */
	parentTriggerMessage: DiscordJsMessage;
	title: string;
	prompt: string;
}

/**
 * Start a new task: create the record, post the live status message,
 * fire-and-forget the runtime. Returns the task record once it's
 * running in the background.
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

	// Resolve the channel we'll post the status message to. We use the
	// trigger message's channel so a task started from within a thread
	// sees its status message in the same thread it was asked from.
	const triggerChannel = opts.parentTriggerMessage.channel;
	if (!('send' in triggerChannel) || !('messages' in triggerChannel)) {
		throw new Error(
			'Trigger message is not in a text channel or thread — task status message cannot be posted.',
		);
	}
	const statusChannel = triggerChannel as Sendable;

	// Create a git worktree so the task's edits are isolated from the
	// running bot's checkout and from every other concurrent task. If
	// this fails (not a git repo / dirty worktree / disk full / …) we
	// still create a record so the failure is visible in the channel,
	// post the status message once, and stop — no runtime drive.
	let worktreePath: string;
	let branch: string;
	let worktreeError: string | null = null;
	try {
		const repoRoot = await findRepoRoot(parentSession.workingDirectory);
		const result = await createWorktreeForTask(
			// A fresh id isn't available yet — taskStore.create generates
			// one. Use a short nonce here as the worktree directory
			// name; the record's own id stays authoritative for status
			// lookups. Good enough for v1 (no cleanup code depends on
			// id/worktree alignment).
			freshWorktreeId(),
			repoRoot,
			TASK_BASE_BRANCH,
		);
		worktreePath = result.worktreePath;
		branch = result.branch;
	} catch (err) {
		worktreeError = err instanceof Error ? err.message : String(err);
		// Placeholder paths so the record is still well-formed. The task
		// will never be driven, so these are never read as cwd.
		worktreePath = parentSession.workingDirectory;
		branch = '';
	}

	// Create the task record (pending → failed below if worktree setup
	// failed; → running if it succeeded).
	const task = taskStore.create({
		parentChannelId: opts.parentChannelId,
		parentGuildId: opts.parentGuildId,
		parentConversationId,
		// Synthetic conversationId for the task's own message history.
		conversationId: `task:${parentConversationId}:${Date.now()}`,
		workingDirectory: worktreePath,
		worktreePath,
		branch,
		title: opts.title,
		initialPrompt: opts.prompt,
	});

	// Post the live status message. We always post once so the operator
	// sees the task — even if worktree creation failed below.
	const statusMessage = await TaskStatusMessage.create(statusChannel, task);
	if (!statusMessage) {
		await taskStore.update(task.id, {
			status: 'failed',
			error: 'Could not post status message for task',
		});
		throw new Error('Failed to post status message for task');
	}

	// If worktree creation failed, transition straight to failed and
	// don't drive the runtime.
	if (worktreeError !== null) {
		await taskStore.update(task.id, {
			statusChannelId: statusMessage.getChannelId(),
			statusMessageId: statusMessage.getMessageId(),
			status: 'failed',
			error: `Could not create task worktree: ${worktreeError}`,
		});
		await statusMessage.finalize(taskStore.get(task.id)!);
		return taskStore.get(task.id) ?? task;
	}

	await taskStore.update(task.id, {
		statusChannelId: statusMessage.getChannelId(),
		statusMessageId: statusMessage.getMessageId(),
		status: 'running',
	});
	statusMessage.updateTask(taskStore.get(task.id)!);
	console.log(
		`[task ${task.id}] transitioned to running, worktree=${worktreePath} branch=${branch}, status message ${statusMessage.getMessageId()} posted in channel ${statusMessage.getChannelId()}`,
	);

	// Fire-and-forget: drive the runtime in the background.
	void driveTask(task.id, opts.prompt, statusMessage, runtime).catch(err => {
		console.error(`[task ${task.id}] driver crashed:`, err);
		void finalizeTask(
			task.id,
			'failed',
			err instanceof Error ? err.message : String(err),
			statusMessage,
		);
	});

	return taskStore.get(task.id) ?? task;
}

/**
 * Mint a short id used as a worktree directory name. We don't reuse
 * taskStore.create's id here because the record id is generated inside
 * that call and we need the worktree path *before* the record exists.
 * Using a distinct nonce is fine: no code cross-references worktree
 * path against record id.
 */
function freshWorktreeId(): string {
	// 8 hex chars. Randomness from Math.random is fine — this is a
	// scratch directory name, not a security-sensitive identifier.
	return Math.random().toString(16).slice(2, 10);
}

/**
 * Interrupt a running task. Aborts the runtime; the driver catches the
 * cancellation and transitions to `cancelled`.
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
	return task;
}

/**
 * Continue an interrupted/completed task with new instructions. Reuses
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
	if (!task.statusChannelId) {
		throw new Error(`Task ${taskId} has no status message to continue in.`);
	}

	const client = clientRef;
	if (!client) throw new Error('Discord client not bound');

	// Fetch the channel the status message lives in.
	let statusChannel: Sendable;
	try {
		const channel = await client.channels.fetch(task.statusChannelId);
		if (!channel || !('send' in channel) || !('messages' in channel)) {
			throw new Error('channel not sendable');
		}
		statusChannel = channel as Sendable;
	} catch (err) {
		throw new Error(
			`Could not access status channel for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Reset abort controller; status → running.
	// (taskStore.create sets one initially, but it was consumed by the
	// previous run.)
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

	// Reattach a TaskStatusMessage around the existing Discord message.
	// If the message is gone, reattach() will post a fresh one in the
	// same channel.
	const statusMessage = await TaskStatusMessage.reattach(
		statusChannel,
		updatedTask,
		task.statusMessageId ?? '',
	);

	// If reattach posted a fresh message, pick up the new id.
	if (statusMessage.getMessageId() !== task.statusMessageId) {
		await taskStore.update(taskId, {
			statusMessageId: statusMessage.getMessageId(),
			statusChannelId: statusMessage.getChannelId(),
		});
	}

	// Post a brief "continuing" marker so the turn boundary is visible.
	await statusChannel
		.send(
			`▶ Continuing task \`${taskId}\` with new instructions: ${truncate(prompt, 200)}`,
		)
		.catch(() => {});

	void driveTask(taskId, prompt, statusMessage, runtime, false).catch(err => {
		console.error(`[task ${taskId}] continuation crashed:`, err);
		void finalizeTask(
			taskId,
			'failed',
			err instanceof Error ? err.message : String(err),
			statusMessage,
		);
	});

	return taskStore.get(taskId) ?? updatedTask;
}

/**
 * Drive a single processMessage round for a task. Wires runtime callbacks
 * into the status message (tool-count + checklist trigger re-renders),
 * persists the message history, manages the activity log, and finalises
 * the status message on completion.
 */
async function driveTask(
	taskId: string,
	prompt: string,
	statusMessage: TaskStatusMessage,
	runtime: HeadlessRuntime,
	skipUserMessage = false,
): Promise<void> {
	const task = taskStore.get(taskId);
	if (!task) {
		console.error(`[task ${taskId}] driveTask: task not found in store`);
		return;
	}
	console.log(
		`[task ${taskId}] driveTask starting, prompt.length=${prompt.length}`,
	);

	const signal = taskStore.getAbortController(taskId)?.signal;

	// Load existing history (for continuations) or start empty.
	const history: Message[] = await messageStore.getMessages(
		task.conversationId,
	);

	try {
		const result = await withChannelContext(
			{
				channelId: task.parentChannelId,
				workingDirectory: task.workingDirectory,
				signal,
			},
			() =>
				withCurrentTask(taskId, () =>
					runtime.processMessage(
						history,
						prompt,
						'auto-accept', // tasks never block on approval prompts
						{
							// Tasks do not stream reasoning into Discord any more.
							// (Tokens still accumulate in the runtime's own buffer so
							// the final response is returned on completion.)
							onToken: () => {},
							// Should never be called in auto-accept mode, but default
							// to approve just in case.
							onToolApproval: async () => 'approve',
							onToolStart: (
								toolName: string,
								args: Record<string, unknown>,
							) => {
								void taskStore.incrementToolCount(taskId);
								void taskStore.appendActivity(taskId, {
									timestampMs: Date.now(),
									kind: 'tool',
									summary: summariseTool(toolName, args),
								});
								// Trigger a status-message re-render so the tool count
								// and any refreshed checklist are visible.
								const t = taskStore.get(taskId);
								if (t) statusMessage.updateTask(t);
							},
							onToolResult: (
								toolName: string,
								output: string,
								isError: boolean,
							) => {
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
							// Tasks do long agentic chains — refactors, multi-file
							// edits, build loops. The default 25-turn cap is far
							// too tight. Give tasks plenty of room; the
							// finalisation-nudge guards in the runtime prevent
							// runaway loops regardless.
							maxTurns: 250,
							// Run all tools — file edits, bash, git — against this
							// task's own git worktree, isolating its edits from
							// the running bot's checkout and from every other
							// concurrent task.
							cwd: task.workingDirectory,
						},
					),
				),
		);

		// Persist the full history.
		await messageStore.saveMessages(task.conversationId, result.messages);

		console.log(
			`[task ${taskId}] processMessage returned, toolCalls=${result.toolCallCount} response.length=${result.response?.length ?? 0}`,
		);

		// Record the assistant's final response in the activity log.
		await taskStore.appendActivity(taskId, {
			timestampMs: Date.now(),
			kind: 'assistant',
			summary: truncate(result.response || '(no output)', 180),
		});
		await finalizeTask(
			taskId,
			'succeeded',
			null,
			statusMessage,
			result.response || '',
		);
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		console.error(`[task ${taskId}] processMessage threw: ${errMsg}`);
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
			statusMessage,
		);
	}
}

async function finalizeTask(
	taskId: string,
	status: 'succeeded' | 'failed' | 'cancelled',
	error: string | null,
	statusMessage: TaskStatusMessage,
	lastResponse?: string,
): Promise<void> {
	const updated = await taskStore.update(taskId, {
		status,
		error,
		lastResponse: lastResponse ?? null,
	});
	if (!updated) return;

	await statusMessage.finalize(updated);

	if (updated.worktreePath && updated.branch) {
		void cleanupWorktree(updated).catch(err => {
			console.warn(
				`[task ${taskId}] worktree cleanup failed (non-fatal):`,
				err instanceof Error ? err.message : String(err),
			);
		});
	}
}

async function cleanupWorktree(task: TaskRecord): Promise<void> {
	// task.worktreePath is /tmp/derek-tasks/<nonce> where the nonce came from
	// freshWorktreeId() — distinct from task.id. Recover it via basename.
	const worktreeNonce = path.basename(task.worktreePath);
	const repoRoot = await findRepoRoot(task.worktreePath);
	console.log(
		`[task ${task.id}] removing worktree ${task.worktreePath} and branch ${task.branch}`,
	);
	await removeWorktreeForTask(worktreeNonce, repoRoot);
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

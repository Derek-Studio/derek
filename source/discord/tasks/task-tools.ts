import type {NanocoderToolExport} from '@/types/core';
import {jsonSchema, tool} from '@/types/core';
import {
	getCurrentTaskId,
	getTaskInvocationContext,
} from './task-invocation-context.js';
import {continueTask, interruptTask, startTask} from './task-runner.js';
import {taskStore} from './task-store.js';
import {
	type ChecklistItem,
	type ChecklistState,
	isTerminal,
	type TaskRecord,
} from './task-types.js';

// ─── task_start ────────────────────────────────────────────────────────────

interface TaskStartArgs {
	title: string;
	prompt: string;
}

const taskStartCoreTool = tool({
	description:
		'Start a long-running background task. Use for anything you estimate will take >30s or more than a few tool calls — refactors, multi-file edits, repo-wide searches, builds, test runs. Returns a task id and thread URL immediately; the task runs in parallel while you keep chatting with the user. Use this INSTEAD OF doing long work inline, so the user can keep asking questions.',
	inputSchema: jsonSchema<TaskStartArgs>({
		type: 'object',
		properties: {
			title: {
				type: 'string',
				description:
					'Short human-readable title for the task thread (e.g. "Refactor auth handlers"). Shown in Discord thread name and status ping. Keep under 80 chars.',
			},
			prompt: {
				type: 'string',
				description:
					'The full instruction for the task. This is the ONLY context the task sees — it has no parent conversation history. Include all necessary detail: goal, relevant files, constraints, acceptance criteria.',
			},
		},
		required: ['title', 'prompt'],
	}),
	needsApproval: false,
	execute: async (args: TaskStartArgs): Promise<string> => {
		const ctx = getTaskInvocationContext();
		if (!ctx) {
			return 'Error: task_start can only be called from within a Discord conversation.';
		}
		try {
			const task = await startTask({
				parentChannelId: ctx.parentChannelId,
				parentGuildId: ctx.parentGuildId,
				parentTriggerMessage: ctx.parentTriggerMessage,
				title: args.title,
				prompt: args.prompt,
			});
			const threadUrl = task.threadId
				? `https://discord.com/channels/${ctx.parentGuildId ?? '@me'}/${task.threadId}`
				: '(no thread)';
			return `Started task \`${task.id}\` "${task.title}". Thread: ${threadUrl}\nThe task is now running in the background. It will post a notification in this channel when it completes.`;
		} catch (err) {
			return `Error: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

export const taskStartTool: NanocoderToolExport = {
	name: 'task_start',
	tool: taskStartCoreTool,
	readOnly: false,
};

// ─── task_status ───────────────────────────────────────────────────────────

interface TaskStatusArgs {
	taskId?: string;
}

const taskStatusCoreTool = tool({
	description:
		'Get the current state of background tasks. With no `taskId`, lists all tasks in this channel (short form). With a `taskId`, returns full detail: status, elapsed time, tool call count, checklist, and the last 10 activity entries. Use this to check on running tasks before deciding whether to wait, interrupt, or start something new.',
	inputSchema: jsonSchema<TaskStatusArgs>({
		type: 'object',
		properties: {
			taskId: {
				type: 'string',
				description:
					'Task id to inspect in detail. Omit to list all tasks in this channel.',
			},
		},
		required: [],
	}),
	needsApproval: false,
	execute: async (args: TaskStatusArgs): Promise<string> => {
		const ctx = getTaskInvocationContext();
		if (!ctx) {
			return 'Error: task_status can only be called from within a Discord conversation.';
		}

		if (args.taskId) {
			const task = taskStore.get(args.taskId);
			if (!task) return `Error: task ${args.taskId} not found.`;
			return renderTaskDetail(task);
		}

		const tasks = taskStore.listForChannel(ctx.parentChannelId);
		if (tasks.length === 0) {
			return 'No tasks in this channel.';
		}
		return tasks.map(renderTaskListLine).join('\n');
	},
});

export const taskStatusTool: NanocoderToolExport = {
	name: 'task_status',
	tool: taskStatusCoreTool,
	readOnly: true,
};

// ─── task_interrupt ────────────────────────────────────────────────────────

interface TaskInterruptArgs {
	taskId: string;
	reason?: string;
}

const taskInterruptCoreTool = tool({
	description:
		'Cancel a running background task. The task transitions to `cancelled`, its thread gets a banner explaining the cancellation, and the parent channel is notified. Use this when the user asks you to stop a running task, or when you want to interrupt one so you can start it again with different instructions (pair with task_continue).',
	inputSchema: jsonSchema<TaskInterruptArgs>({
		type: 'object',
		properties: {
			taskId: {
				type: 'string',
				description: 'The id of the task to interrupt.',
			},
			reason: {
				type: 'string',
				description:
					'Optional short explanation of why the task is being interrupted (shown in the cancellation banner).',
			},
		},
		required: ['taskId'],
	}),
	needsApproval: false,
	execute: async (args: TaskInterruptArgs): Promise<string> => {
		const task = await interruptTask(args.taskId, args.reason);
		if (!task) return `Error: task ${args.taskId} not found.`;
		if (isTerminal(task.status)) {
			return `Task ${args.taskId} was already ${task.status}; nothing to interrupt.`;
		}
		return `Interrupting task ${args.taskId}. The task will transition to 'cancelled' shortly.`;
	},
});

export const taskInterruptTool: NanocoderToolExport = {
	name: 'task_interrupt',
	tool: taskInterruptCoreTool,
	readOnly: false,
};

// ─── task_continue ─────────────────────────────────────────────────────────

interface TaskContinueArgs {
	taskId: string;
	prompt: string;
}

const taskContinueCoreTool = tool({
	description:
		"Resume a completed or cancelled task with new instructions. The task's full message history is preserved — this is how you steer a task that stopped short, correct a mistake, or add a follow-up. Runs in the same Discord thread.",
	inputSchema: jsonSchema<TaskContinueArgs>({
		type: 'object',
		properties: {
			taskId: {
				type: 'string',
				description: 'The id of the task to continue.',
			},
			prompt: {
				type: 'string',
				description:
					'The new instructions. The task has full memory of its prior messages and tool results.',
			},
		},
		required: ['taskId', 'prompt'],
	}),
	needsApproval: false,
	execute: async (args: TaskContinueArgs): Promise<string> => {
		try {
			const task = await continueTask(args.taskId, args.prompt);
			return `Continuing task ${task.id} "${task.title}". See its thread for live progress; a notification will be posted here when it finishes.`;
		} catch (err) {
			return `Error: ${err instanceof Error ? err.message : String(err)}`;
		}
	},
});

export const taskContinueTool: NanocoderToolExport = {
	name: 'task_continue',
	tool: taskContinueCoreTool,
	readOnly: false,
};

// ─── task_wait ─────────────────────────────────────────────────────────────

interface TaskWaitArgs {
	taskId: string;
	timeoutSec?: number;
}

const DEFAULT_WAIT_TIMEOUT_SEC = 300;
const MAX_WAIT_TIMEOUT_SEC = 1800;

const taskWaitCoreTool = tool({
	description:
		"Block the current turn until a task reaches a terminal state (succeeded/failed/cancelled). Use this only when you genuinely need the task's result before continuing to respond — most of the time you should let the task run in the background and acknowledge it on your next turn instead. Returns the task's final status and response summary.",
	inputSchema: jsonSchema<TaskWaitArgs>({
		type: 'object',
		properties: {
			taskId: {
				type: 'string',
				description: 'The id of the task to wait for.',
			},
			timeoutSec: {
				type: 'number',
				description: `How long to wait before giving up, in seconds (default ${DEFAULT_WAIT_TIMEOUT_SEC}, max ${MAX_WAIT_TIMEOUT_SEC}).`,
			},
		},
		required: ['taskId'],
	}),
	needsApproval: false,
	execute: async (args: TaskWaitArgs): Promise<string> => {
		const timeout = Math.min(
			Math.max(args.timeoutSec ?? DEFAULT_WAIT_TIMEOUT_SEC, 1),
			MAX_WAIT_TIMEOUT_SEC,
		);
		try {
			const task = await taskStore.waitForTerminal(args.taskId, timeout * 1000);
			return renderTaskDetail(task);
		} catch (err) {
			// Timed out or task not found.
			const msg = err instanceof Error ? err.message : String(err);
			return `Error: ${msg}`;
		}
	},
});

export const taskWaitTool: NanocoderToolExport = {
	name: 'task_wait',
	tool: taskWaitCoreTool,
	readOnly: true,
};

// ─── task_checklist (task-internal only) ──────────────────────────────────

interface TaskChecklistArgs {
	items: Array<{label: string; state: ChecklistState}>;
}

const taskChecklistCoreTool = tool({
	description:
		"Update the checklist shown in this task's Discord thread header. Call this at the start of the task to lay out the plan, then again each time you finish or start a step. States: 'pending' (not started), 'doing' (in progress), 'done' (finished), 'skipped' (decided not to do). Replaces the entire checklist each call — pass the full updated list every time.",
	inputSchema: jsonSchema<TaskChecklistArgs>({
		type: 'object',
		properties: {
			items: {
				type: 'array',
				description: 'The complete ordered checklist.',
				items: {
					type: 'object',
					properties: {
						label: {
							type: 'string',
							description: 'Short description of the step.',
						},
						state: {
							type: 'string',
							enum: ['pending', 'doing', 'done', 'skipped'],
							description: 'Current state of the step.',
						},
					},
					required: ['label', 'state'],
				},
			},
		},
		required: ['items'],
	}),
	needsApproval: false,
	execute: async (args: TaskChecklistArgs): Promise<string> => {
		const taskId = getCurrentTaskId();
		if (!taskId) {
			return 'Error: task_checklist can only be called from inside a running task.';
		}
		if (!Array.isArray(args.items)) {
			return 'Error: `items` must be an array of {label, state} objects.';
		}
		const checklist: ChecklistItem[] = args.items.map(i => ({
			label: String(i.label ?? '').slice(0, 200),
			state: normaliseState(i.state),
		}));
		await taskStore.setChecklist(taskId, checklist);
		return `Updated checklist (${checklist.length} items).`;
	},
});

export const taskChecklistTool: NanocoderToolExport = {
	name: 'task_checklist',
	tool: taskChecklistCoreTool,
	readOnly: false,
};

function normaliseState(s: string): ChecklistState {
	if (s === 'pending' || s === 'doing' || s === 'done' || s === 'skipped') {
		return s;
	}
	return 'pending';
}

// ─── Bundles ──────────────────────────────────────────────────────────────

/**
 * All task tools, for convenience when registering into the runtime.
 * The gateway registers them all; `processMessage`'s `excludeTools` then
 * filters them per-call to enforce the main-channel / task-internal split.
 */
export const allTaskTools: NanocoderToolExport[] = [
	taskStartTool,
	taskStatusTool,
	taskInterruptTool,
	taskContinueTool,
	taskWaitTool,
	taskChecklistTool,
];

// ─── Rendering helpers ────────────────────────────────────────────────────

function statusEmoji(status: TaskRecord['status']): string {
	switch (status) {
		case 'pending':
			return '🟡';
		case 'running':
			return '🟢';
		case 'succeeded':
			return '✅';
		case 'failed':
			return '❌';
		case 'cancelled':
			return '⏹';
	}
}

function formatElapsed(ms: number): string {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	const remSec = sec % 60;
	if (min < 60) return `${min}m ${remSec.toString().padStart(2, '0')}s`;
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return `${hr}h ${remMin.toString().padStart(2, '0')}m`;
}

function renderTaskListLine(task: TaskRecord): string {
	const elapsed = task.endedAt
		? formatElapsed(task.endedAt - task.startedAt)
		: formatElapsed(Date.now() - task.startedAt);
	return `- task \`${task.id}\` "${task.title}" — ${statusEmoji(task.status)} ${task.status} · ${elapsed} · ${task.toolCallCount} tool calls`;
}

function renderTaskDetail(task: TaskRecord): string {
	const elapsed = task.endedAt
		? formatElapsed(task.endedAt - task.startedAt)
		: formatElapsed(Date.now() - task.startedAt);
	const lines: string[] = [
		`Task \`${task.id}\` "${task.title}"`,
		`Status: ${statusEmoji(task.status)} ${task.status} · ${elapsed} · ${task.toolCallCount} tool calls`,
	];
	if (task.error) {
		lines.push(`Error: ${task.error}`);
	}
	if (task.checklist.length > 0) {
		lines.push('', 'Checklist:');
		for (const item of task.checklist) {
			const glyph =
				item.state === 'done'
					? '✓'
					: item.state === 'doing'
						? '▸'
						: item.state === 'skipped'
							? '↷'
							: '○';
			lines.push(`  ${glyph} ${item.label}`);
		}
	}
	if (task.activity.length > 0) {
		lines.push('', 'Last activity:');
		const recent = task.activity.slice(-10);
		for (const entry of recent) {
			const delta = formatElapsed(entry.timestampMs - task.startedAt);
			lines.push(`  [${delta}] ${entry.kind}: ${entry.summary}`);
		}
	}
	if (isTerminal(task.status) && task.lastResponse) {
		lines.push('', 'Final output:', truncate(task.lastResponse, 1000));
	}
	return lines.join('\n');
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}

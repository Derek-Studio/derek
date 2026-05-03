/**
 * Tasks: agent-driven background units of work.
 *
 * The main agent decides "this is going to take a while" and calls
 * `task_start`. A Task runs in its own `processMessage` call. Its
 * entire user-visible surface is a **single live status message** in
 * the parent channel, edited in place as the task progresses. On
 * terminal transition the message shows the final status/result/error.
 * The main agent learns about completion via the auto-injected ACTIVE
 * TASKS prompt block on its next real turn.
 *
 * Tasks always inherit the parent channel's working directory, run in
 * `auto-accept` mode (no human approval prompts mid-task), and never
 * spawn sub-tasks.
 */

export type TaskStatus =
	| 'pending'
	| 'running'
	| 'succeeded'
	| 'failed'
	| 'cancelled';

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
	'succeeded',
	'failed',
	'cancelled',
]);

export function isTerminal(status: TaskStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

export type ChecklistState = 'pending' | 'doing' | 'done' | 'skipped';

export interface ChecklistItem {
	label: string;
	state: ChecklistState;
}

/**
 * One activity entry in a task's transcript log. Used by `task_status` to
 * surface recent progress to the main agent without dumping the full
 * Discord thread.
 */
export interface ActivityEntry {
	timestampMs: number;
	kind: 'tool' | 'assistant' | 'error' | 'status';
	/** Short human-readable summary, ≤200 chars when serialised. */
	summary: string;
}

export interface TaskRecord {
	id: string;
	parentChannelId: string;
	parentGuildId?: string;
	parentConversationId: string;
	/**
	 * Channel id where this task's live status message lives. Usually the
	 * same as parentChannelId, but kept separate for clarity / future
	 * flexibility (e.g. if we ever let tasks post elsewhere).
	 */
	statusChannelId: string | null;
	/**
	 * Discord message id of the single live status message. Edited in
	 * place as the task runs. Null until the task has been posted.
	 */
	statusMessageId: string | null;
	/** This task's own conversation id in messageStore (forked from parent). */
	conversationId: string;
	/** Inherited from parent at task creation. Never changes. */
	workingDirectory: string;
	title: string;
	initialPrompt: string;
	status: TaskStatus;
	checklist: ChecklistItem[];
	toolCallCount: number;
	startedAt: number;
	endedAt: number | null;
	error: string | null;
	/**
	 * Set when the main agent has been shown this task in its ACTIVE TASKS
	 * prompt block in a terminal state. Used so a finished task only
	 * appears once in the agent's auto-inject.
	 */
	acknowledgedAt: number | null;
	/** Bounded recent activity log, used by task_status. */
	activity: ActivityEntry[];
	/** Final assistant text from the most recent processMessage round. */
	lastResponse: string | null;
}

/** Maximum activity entries kept per task. */
export const MAX_ACTIVITY_ENTRIES = 30;

/** Per-channel concurrency cap for non-terminal tasks. */
export const MAX_CONCURRENT_TASKS_PER_CHANNEL = 3;

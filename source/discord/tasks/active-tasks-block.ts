import {taskStore} from './task-store.js';
import {isTerminal, type TaskRecord} from './task-types.js';

/**
 * Build the `ACTIVE TASKS` block appended to every main-channel turn's
 * system prompt. Lists:
 *   - all non-terminal tasks in this channel (running / pending)
 *   - terminal tasks that completed since this channel's last turn and
 *     haven't been acknowledged yet (so the agent sees them once)
 *
 * Returns an empty string when there are no tasks to report — callers
 * should skip appending in that case.
 *
 * After the turn, the caller should pass the returned `acknowledgeIds`
 * to `taskStore.acknowledge()` so newly-terminal tasks don't keep
 * reappearing on subsequent turns.
 */
export interface ActiveTasksBlock {
	text: string;
	acknowledgeIds: string[];
}

export function buildActiveTasksBlock(
	parentChannelId: string,
	lastTurnStartedAt: number,
): ActiveTasksBlock {
	const active = taskStore.listActiveForChannel(parentChannelId);
	const newlyTerminal = taskStore.listUnacknowledgedTerminalForChannel(
		parentChannelId,
		lastTurnStartedAt,
	);

	if (active.length === 0 && newlyTerminal.length === 0) {
		return {text: '', acknowledgeIds: []};
	}

	const lines: string[] = ['## ACTIVE TASKS in this channel'];

	if (active.length > 0) {
		lines.push('', '**Currently running:**');
		for (const t of active) {
			lines.push(renderActiveLine(t));
		}
	}

	if (newlyTerminal.length > 0) {
		lines.push(
			'',
			'**Completed since your last turn** (mention these in your reply):',
		);
		for (const t of newlyTerminal) {
			lines.push(renderTerminalLine(t));
		}
	}

	lines.push(
		'',
		'You can use `task_status`, `task_interrupt`, `task_continue`, or `task_wait` to inspect or manage these tasks.',
	);

	return {
		text: lines.join('\n'),
		acknowledgeIds: newlyTerminal.map(t => t.id),
	};
}

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

function renderActiveLine(task: TaskRecord): string {
	const elapsed = formatElapsed(Date.now() - task.startedAt);
	const checklistTail = task.checklist
		.filter(i => i.state === 'doing')
		.map(i => i.label)
		.join(', ');
	const suffix = checklistTail ? ` — currently: ${checklistTail}` : '';
	return `- task \`${task.id}\` "${task.title}" — ${statusEmoji(task.status)} ${task.status} · ${elapsed} · ${task.toolCallCount} tool calls${suffix}`;
}

function renderTerminalLine(task: TaskRecord): string {
	const elapsed = task.endedAt
		? formatElapsed(task.endedAt - task.startedAt)
		: '?';
	const summary =
		task.lastResponse && task.status === 'succeeded'
			? `\n  Result: ${truncate(task.lastResponse, 400)}`
			: task.error
				? `\n  ${task.status === 'cancelled' ? 'Cancelled' : 'Error'}: ${truncate(task.error, 400)}`
				: '';
	return `- task \`${task.id}\` "${task.title}" — ${statusEmoji(task.status)} ${task.status} · ${elapsed} · ${task.toolCallCount} tool calls${summary}`;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}

// Re-export isTerminal so callers don't need to import from task-types.
export {isTerminal};

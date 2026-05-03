import {execFile} from 'node:child_process';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Where per-task git worktrees are created. One subdirectory per task.
 *
 * Design note: living under `/tmp` means the OS will (eventually) clean
 * up after a crash. We don't depend on that — orphan worktrees just
 * accumulate on disk until a human runs `git worktree prune` from a
 * shell, which is acceptable for v1.
 */
const WORKTREE_BASE = '/tmp/derek-tasks';

/**
 * Walk up from `startPath` looking for a `.git` directory or file
 * (linked worktrees and submodules use a `.git` *file* that points at
 * the real git dir — both are valid). Returns the absolute path of the
 * directory that contains `.git`. Throws a descriptive error if no
 * `.git` is found anywhere on the way up.
 */
export async function findRepoRoot(startPath: string): Promise<string> {
	let dir = path.resolve(startPath);
	const root = path.parse(dir).root;

	while (true) {
		try {
			await access(path.join(dir, '.git'));
			return dir;
		} catch {
			// .git not here — keep walking.
		}

		if (dir === root) {
			throw new Error(
				`No git repository found at or above ${startPath}. ` +
					'Tasks require a git repo (one worktree per task).',
			);
		}
		dir = path.dirname(dir);
	}
}

/**
 * Create a fresh git worktree for the given task.
 *
 * Runs `git worktree add /tmp/derek-tasks/<taskId> -b task/<taskId>
 * <baseBranch>` in `repoRoot`. The new worktree starts off `baseBranch`
 * (typically `dev`) on a fresh branch named `task/<taskId>` so the
 * task's edits are isolated from the running bot's checkout and from
 * every other concurrent task.
 *
 * Returns the worktree path and the new branch name. If the underlying
 * git command fails (uncommitted changes that block worktree add,
 * non-existent base branch, disk full, etc.) the rejection's message
 * surfaces git's stderr verbatim so the caller can report it.
 */
export async function createWorktreeForTask(
	taskId: string,
	repoRoot: string,
	baseBranch: string,
): Promise<{worktreePath: string; branch: string}> {
	const worktreePath = path.join(WORKTREE_BASE, taskId);
	const branch = `task/${taskId}`;

	try {
		await execFileAsync(
			'git',
			['worktree', 'add', worktreePath, '-b', branch, baseBranch],
			{cwd: repoRoot},
		);
	} catch (err) {
		const stderr =
			err && typeof err === 'object' && 'stderr' in err
				? String((err as {stderr: unknown}).stderr).trim()
				: '';
		const message =
			stderr || (err instanceof Error ? err.message : String(err));
		throw new Error(
			`git worktree add failed (repo=${repoRoot}, base=${baseBranch}): ${message}`,
		);
	}

	return {worktreePath, branch};
}

/**
 * Remove a task's worktree and delete its branch. Symmetric counterpart
 * to `createWorktreeForTask`. Not wired into the v1 task lifecycle —
 * provided so a future cleanup command (or a startup sweep) can call
 * it. v1 leaves orphan worktrees on disk for the operator to prune
 * manually.
 */
export async function removeWorktreeForTask(
	taskId: string,
	repoRoot: string,
): Promise<void> {
	const worktreePath = path.join(WORKTREE_BASE, taskId);
	const branch = `task/${taskId}`;

	// `--force` so we don't fail on uncommitted edits in the worktree.
	await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], {
		cwd: repoRoot,
	}).catch(() => {
		// Worktree may already be gone; that's fine.
	});

	await execFileAsync('git', ['branch', '-D', branch], {cwd: repoRoot}).catch(
		() => {
			// Branch may already be gone; that's fine.
		},
	);
}

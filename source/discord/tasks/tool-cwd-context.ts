import {AsyncLocalStorage} from 'node:async_hooks';

/**
 * Per-call working directory for path-resolving tools.
 *
 * The gateway and task runner wrap every `processMessage` invocation in
 * `withToolCwd(cwd, () => runtime.processMessage(...))`. Tools that
 * resolve user-supplied paths (read_file, write_file, execute_bash,
 * git helpers, …) read the stored cwd via `getToolCwd()` instead of
 * calling `process.cwd()` directly. That lets multiple Discord channels
 * and multiple concurrent tasks each operate on their own directory
 * (or git worktree) without racing on the shared process cwd.
 *
 * When a tool is called outside of a wrapped call (e.g. from the
 * interactive Ink CLI, from tests, or from any non-Discord caller),
 * `getToolCwd()` falls back to `process.cwd()` — which is the same
 * behaviour as before the plumbing existed.
 */

const storage = new AsyncLocalStorage<string>();

/**
 * Run `fn` with the given `cwd` as the ambient tool-resolution
 * directory. The cwd is propagated through async boundaries via
 * `AsyncLocalStorage`, so any tool execution nested inside the
 * callback sees the same value.
 */
export function withToolCwd<T>(
	cwd: string,
	fn: () => T | Promise<T>,
): T | Promise<T> {
	return storage.run(cwd, fn);
}

/**
 * Current ambient tool cwd, or `process.cwd()` if called outside of a
 * `withToolCwd(...)` wrapper.
 */
export function getToolCwd(): string {
	return storage.getStore() ?? process.cwd();
}

# Parallel tasks via git worktrees — minimal design

## Goal

Let multiple Derek background tasks run concurrently against the same
repository without stomping on each other's file edits, by giving each
task its own `git worktree` on its own branch off `dev`.

Merging back into `dev` stays a manual human step (same as today's
self-modification rule). No slash commands, no per-project policy in
AGENTS.md — those are follow-ups, explicitly out of scope here.

## Scope (what this design covers)

- Every task gets a worktree. No `read` / `edit` / `attach` modes. If a
  task just reads, it pays a cheap worktree setup cost — acceptable for
  simplicity.
- Worktrees live at `/tmp/derek-tasks/<taskId>/`.
- Branch is `task/<taskId>` off `dev`.
- No auto-merge. Tasks finish on their branch; human merges from a shell
  when ready.
- `task_continue` reuses the same worktree + branch (same line of work).
- `node_modules`: tasks that need one run `pnpm install` themselves.
- Cleanup is on-demand, from a shell, not via bot commands.

## Out of scope (explicitly deferred)

- Read/edit/attach task modes.
- Auto-merge policies / AGENTS.md `derek.taskMerge`.
- Slash commands (`/task-merge`, `/task-discard`, `/task-prune`).
- Startup worktree sweep / TTL pruning.
- `node_modules` symlinking or caching.
- Cross-task attachment (two tasks sharing a branch).

Each of these is a clean layer on top of this design. Don't pre-build
them.

## Current blockers (grounded in code)

1. **Shared `process.cwd()`.** `gateway.ts:417` calls `process.chdir`
   and restores it at `:545`. Tasks are fire-and-forget (`void
   driveTask` at `task-runner.ts:155`), so they run *after* the main
   turn's `finally` has restored cwd. All path-resolving tools
   (`read_file`, `write_file`, `string_replace`, `list_directory`,
   `find_files`, `search_file_contents`, `create_directory`,
   `delete_file`, `move_file`, `copy_file`, `execute_bash`, git tools)
   resolve against `process.cwd()` and therefore don't see the task's
   intended working directory.

2. **No worktree infrastructure.** No code creates, tracks, or prunes
   `git worktree`s today.

3. **`TaskRecord.workingDirectory` is captured but never applied.**
   `task-runner.ts:124` copies it from the parent session; `driveTask`
   at `:287` never reads it.

## Design

### 1. Per-task CWD plumbing (prerequisite)

Thread an explicit `cwd: string` through the agent loop instead of
relying on `process.cwd()`.

- `HeadlessRuntime.processMessage(..., options)` gains `options.cwd`.
- The runtime passes `cwd` into the tool-execution context.
- Every path-resolving tool replaces `path.resolve(args.path)` with
  `path.resolve(cwd, args.path)`.
- `execute_bash` and git-utility subprocess spawns pass `cwd` explicitly.
- Delete `process.chdir` from `gateway.ts:415-420` and `:545`. The
  gateway passes `session.workingDirectory` into `processMessage`
  instead.

This one change fixes the existing cross-channel CWD race *and* enables
worktrees. It's valuable on its own and should land first.

### 2. Worktree lifecycle

New module: `source/discord/tasks/worktree-manager.ts`. Thin wrapper
around `git worktree` shell-outs. Responsibilities:

- `createForTask(taskId, repoRoot, baseBranch): Promise<string>` —
  runs `git worktree add /tmp/derek-tasks/<taskId> -b task/<taskId> <baseBranch>`
  in `repoRoot`. Returns the worktree path.
- `removeForTask(taskId, repoRoot): Promise<void>` — `git worktree
  remove` + `git branch -D task/<taskId>`. Used only if we decide to
  clean up on explicit request later; not wired in v1.

That's it. No tracking map, no startup sweep, no slash commands. The
`TaskRecord` stores the worktree path; that's the source of truth.

Base branch: hardcode `dev` for now. Generalising to
per-project is a follow-up.

Repo root: derived from the parent session's `workingDirectory` by
walking up to the nearest `.git` directory. If there's no git repo,
task creation fails with a clear error — tasks require a repo in this
design.

### 3. TaskRecord changes

Add two fields:

```ts
interface TaskRecord {
  ...
  /** Absolute path to the task's git worktree. Same as workingDirectory. */
  worktreePath: string;
  /** Branch name, e.g. `task/<taskId>`. */
  branch: string;
}
```

`workingDirectory` stays as the field `driveTask` reads — we just set
it to `worktreePath` at creation. Keeps the plumbing uniform.

### 4. `startTask` changes

In `task-runner.ts:startTask`:

1. Resolve the parent session's repo root.
2. Call `worktreeManager.createForTask(taskId, repoRoot, 'dev')`.
3. Store the returned path on the `TaskRecord` as both `worktreePath`
   and `workingDirectory`.
4. Rest of the flow unchanged.

If worktree creation fails, the task is created with status `failed`
and a clear error message. Don't leave half-created state.

### 5. `driveTask` changes

Pass `task.workingDirectory` as `options.cwd` into `runtime.processMessage`.
That's the only change here, and it's the reason item 1 had to land first.

### 6. `task_continue` changes

No changes needed. The task's `workingDirectory` is already persisted;
continuing reuses it naturally.

## Required code changes (checklist)

- [ ] **Per-task CWD plumbing** — thread `cwd` through `processMessage`
      → tool context → every path-resolving tool and every subprocess
      spawn. Delete `process.chdir` from `gateway.ts`. Verify with the
      existing CWD-bug scenario (task started from one channel sees the
      right files).
- [ ] **`worktree-manager.ts`** — `createForTask` only. ~40 lines.
- [ ] **`TaskRecord`** — add `worktreePath` and `branch` fields.
- [ ] **`startTask`** — create worktree, set task cwd to worktree path.
- [ ] **`driveTask`** — pass `task.workingDirectory` as `cwd` into
      `processMessage`.
- [ ] **Error path** — if worktree creation throws, mark task `failed`
      with a clean error; don't leak a partial `.git` state.

No other files change. No new tools. No slash commands. No prompt
changes. No AGENTS.md parsing.

## Risks & edge cases

- **Orphan worktrees on crash.** The bot dies mid-task; the worktree
  stays on disk. Accepted for v1 — operator cleans up with
  `git worktree remove` from a shell. A startup sweep is a follow-up.
- **Disk usage.** ~10-50MB per worktree (no `node_modules`). Bounded by
  `MAX_CONCURRENT_TASKS_PER_CHANNEL = 3`. Fine.
- **`pnpm install` in a worktree is slow the first time.** Tasks that
  don't need it skip it. Tasks that do pay once. pnpm's
  content-addressable store makes subsequent installs cheap.
- **Merge conflicts at human-merge time.** Exactly what humans deal
  with. Out of scope for the bot.
- **Running bot vs task worktree.** The live systemd-managed bot runs
  from `/root/projects/derek-dev` on `dev`. A task editing source in
  its own worktree doesn't affect the running bot until a human merges
  and restarts. This is the desired property — it gives a review gate.
- **`git worktree add` requires a clean-ish repo.** If `dev` has
  uncommitted changes in the main worktree at task-creation time, the
  new worktree is still created successfully (worktrees are
  independent), so this is not a real issue.
- **Non-git projects.** Task creation fails with an error. Acceptable
  — the whole point of this design is git isolation.

## Minimal v1 summary

Three edits do the bulk of it:

1. Thread `cwd` through `processMessage` and every path-resolving tool
   / subprocess spawn. Delete `process.chdir`.
2. Add `worktree-manager.createForTask`.
3. Have `startTask` call it and store the path; have `driveTask` pass
   that path as `cwd`.

Everything else (merge UX, policies, modes, cleanup) is a later
layer and should not block v1.

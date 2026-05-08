## DISCORD TASKS

You are running inside a Discord conversation. Some work takes long enough
that doing it inline would block the user from chatting — for that, use
**tasks**.

### When to use a task (auto-routing — required)

**Automatically start a task with `task_start` for any of the following — do not ask the user first:**
- Any code change, file edit, or refactor (even a single file)
- Multi-file work, repo-wide searches, or anything touching more than one file
- Running tests, builds, type-checks, or deployments
- Any planning or design work requiring more than 2 tool calls
- Anything you estimate will take more than ~30 seconds

**Only respond inline (no task) for:**
- Simple factual questions or single-file reads with no edits
- Quick status checks (e.g. "what tasks are running?")
- Acknowledging a task that just finished

When in doubt, use a task. The user should never have to say "use a task for this."

### How tasks work

- `task_start` returns **immediately** with a task id. The task runs in
  parallel while you keep responding to the user in the main channel.
- A single live status message is posted in the channel where you were
  asked to start the task. That message is **edited in place** as the
  task progresses — status badge (🟡 → 🟢 → ✅/❌/⏹), elapsed time,
  tool count, checklist, and (on completion) the final result. There is
  no separate thread.
- A task has its own isolated conversation — it does NOT see the main
  channel's history. Put everything it needs into the `prompt` arg.
- You will see tasks that completed since your last turn surfaced in
  the `ACTIVE TASKS` block at the top of your context on your next
  turn. Acknowledge them in your reply ("the refactor task finished,
  tests pass") rather than pretending you don't know about them.

### Managing running tasks

- `task_status` — check what a task is up to without blocking
- `task_output` — fetch the **full** activity log and **full** final response for a task (uncapped — use when `task_status` isn't enough detail)
- `task_interrupt` — stop a running task (e.g. user said "wait, don't do that")
- `task_continue` — give a stopped or completed task new instructions with its full history preserved
- `task_continue` is also how you **resume a task waiting for a decision** — e.g. if a task finished and is waiting for you to say "merge it", call `task_continue` with `"merge to dev now"`
- `task_wait` — block your turn until a task finishes (use sparingly; usually letting it run in the background is better)

### Inside a task

When you're running as a task (this prompt appears in the task's own
runtime), you have the normal tool set plus `task_checklist`. Use
`task_checklist` at the start to lay out your plan, and update it as you
progress. The checklist is rendered live in the task's status message so
the operator can see progress at a glance.

Tasks cannot spawn sub-tasks — task-management tools (other than
`task_checklist`) are not available inside a task run.

### Inside a task — commit behavior

Git commits are the task's durable record. Make them frequently:

1. At the start: lay out your plan with `task_checklist`
2. After each logical unit of work: commit with a descriptive message — do not batch everything into one commit at the end
3. Before any risky operation (test run, build): commit whatever is clean so you have a restore point
4. At the end of a successful task: commit any remaining uncommitted changes before writing your final response

Use `git add <specific-files>` rather than `git add .` to avoid staging unrelated files.

### Inside a task — end-of-task behavior

When your work is complete:

1. Commit any remaining changes
2. **Auto-merge to `dev` by default** — unless the task prompt contains "don't merge", "no merge", or "review first", or the project's AGENTS.md contains a `NO_AUTO_MERGE` directive

To merge, find the worktree that has `dev` checked out, then merge and push:
```bash
# Find the dev worktree path
git worktree list --porcelain | awk '/^worktree /{wt=$2} /^branch refs\/heads\/dev/{print wt; exit}'

# Merge and push
git -C <dev-worktree-path> merge --no-ff task/<id> -m "Merge task/<id>: <title>"
git -C <dev-worktree-path> push origin dev
```

Your **final response must include**:
1. A summary of what was done
2. Whether the branch was merged (and any conflicts), or why it was skipped
3. If merge was skipped: the branch name (`task/<id>`) and how to merge manually

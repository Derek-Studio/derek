# Plan: Replace queue-based blocking with parallel Tasks (v2)

> **v2 changes from v1:**
> - **Tasks always inherit the parent channel's working directory.** No
>   `workingDirectory` arg on `task_start`. Removes the entire
>   `process.chdir` / AsyncLocalStorage refactor (was Phase 0). No tools
>   need to change.
> - **No synthetic-message-into-parent-history feedback loop.** When a task
>   reaches a terminal state, it pings the parent channel as a normal
>   message — that's it. The main agent learns about completed tasks via
>   the auto-injected `ACTIVE TASKS` block on its next turn (i.e. the next
>   time the operator sends a message). Simpler, more predictable, no risk
>   of the agent waking itself up unprompted at 3am.

## 1. What exists today (the thing being replaced)

### 1.1 The blocking model

`source/discord/gateway.ts` runs a **per-channel state machine** (`channelStates`,
`ChannelRunState`). At most one `runAgentTurn` executes per channel at a time:

```
handleMessage → state.queued.push → if state.active: show QueuePrompt
                                  → else: drainQueueAndRun → runAgentTurn
```

Anything the user sends while a turn is running goes into `state.queued`. When the
active run finishes, `drainQueueAndRun` loops, combines all queued messages into
**one** synthetic user turn (`buildCombinedUserContent`), and runs again.

Result: the operator can never get a fast answer to "what is this project?"
while a 10-minute refactor is running. They have to either wait, redirect the
queue, or interrupt the run.

### 1.2 The escape hatches (also being removed)

Two pre-existing escape hatches both have problems:

**A. `QueuePrompt` buttons** (`source/discord/ui/queue-prompt.ts`) shown when a
message queues during an active run:

- 🔀 **Run queued in background** — pulls queued messages into a forked thread
  via `forkToThread`. The current run continues in the main channel.
- 🧵 **Move current to thread** — aborts the current run with reason
  `swap_to_thread`, then re-runs the *same* user input in a forked thread while
  queued messages drain into the main channel.

This is operator-driven, decided *after* a message has already queued. The
agent has no say in whether something should be backgrounded.

**B. `/task` slash command + `runBackgroundTask`** in gateway.ts:

- Operator types `/task <prompt>`, gateway creates a Discord thread, fires off
  `runBackgroundTask` with **fresh** history (no parent context) and `auto-accept`
  mode (always approves all tools). Posts a tool-call status every 8 calls,
  pings the user when done.
- No way for the running agent to start one. No status checklist. No way to
  inspect, interrupt with new instructions, or feed results back into the main
  channel's history.

### 1.3 Things both escape hatches share

- Both create a **Discord thread** off a trigger message.
- Both call `discordSessionStore.forkSession` to clone session metadata
  (workingDir, model, provider, mode) under a new conversationId.
- `messageStore` is a per-conversationId JSON file. Each thread = its own file.
- `forkToThread` injects a synthetic `user`/`assistant` exchange into the
  *parent* conversation when the thread finishes. **Tasks v2 deliberately
  drops this** — see the v2 changes box at the top.
- **`HeadlessRuntime` is a process-wide singleton** — one `client`, one
  `toolManager`. Multiple `processMessage` calls already happen concurrently
  whenever a forkToThread / `/task` is in flight today. The shared
  `process.cwd()` is a known race, but in practice it has not bitten because
  `runBackgroundTask` deliberately doesn't `chdir` and most tasks operate
  under the parent's cwd anyway. **Tasks v2 makes this explicit:** every
  task inherits the parent channel's working directory and never overrides
  it. Concurrent tasks under the same channel share a cwd → safe to chdir.
  Concurrent runs across different channels were already a latent race
  today and remain one — out of scope for this change.
- `requestToolApproval` works by `channel.send` + `awaitMessageComponent`.
  Approval buttons are scoped to the channel they're posted in, so concurrent
  approvals in a main channel and a thread don't interfere — *as long as* the
  task always uses auto-accept (which is what `runBackgroundTask` does today
  and what tasks will do).

### 1.4 What the agent currently knows

Nothing. The agent's system prompt (`source/app/prompts/sections/`) talks about
the in-process `agent` tool (subagents that block until they return) and an
in-memory todo list (`task_management`). The agent has **no Discord-aware tool**
to fire-and-forget a long-running task, no way to query task status, and no way
to interrupt or steer one.

---

## 2. The proposed model

### 2.1 Concept

A **Task** is a unit of agent work that:

1. Was decided to be long-running by the **main agent** (not the operator),
2. Runs in its own `runtime.processMessage` call against an isolated session,
3. **Inherits the parent channel's working directory** (no override),
4. Lives in a Discord thread that contains its full transcript (reasoning,
   tool calls, results) as append-only messages,
5. Has a thread-header message that shows a checklist of progress, edited
   in place,
6. Has a status: `pending → running → succeeded | failed | cancelled`,
7. **When status changes to a terminal state, posts a result message in the
   parent channel** (a normal Discord message, with the task summary). The
   main agent does NOT automatically run a turn in response. It learns about
   completed tasks via the auto-injected `ACTIVE TASKS` block on its next
   real turn.

The user sending `"can you also fix the bug in /api/foo"` in the main channel
**while a task is running** does not block. The main agent sees the new
message, sees that a task is in flight (via the auto-injected block), and
either:

- handles the new request in the main turn while the task runs in parallel,
- calls `task_interrupt` to kill the running task and steer it differently, or
- starts a new parallel task.

### 2.2 The five new tools

Tools the main agent can call from the Discord conversation. All are
Discord-runtime-only (registered conditionally — they don't appear in CLI mode).

| Tool | Purpose |
|---|---|
| `task_start` | Kick off a new Task. Args: `title`, `prompt`. (No `workingDirectory` — always inherits parent.) Returns `taskId`. |
| `task_status` | Read current state of one or more Tasks: status, last N transcript lines, current checklist. Args: `taskId?` (omit = list all in this channel). |
| `task_interrupt` | Cancel a running Task. Args: `taskId`, `reason?`. Aborts the runtime, posts an "interrupted" message, transitions to `cancelled`. |
| `task_continue` | Steer an interrupted/completed Task with new instructions. Args: `taskId`, `prompt`. Reuses its session + history, kicks off another `processMessage` round. |
| `task_wait` | Block the *current* main-agent turn until a Task reaches a terminal state. Args: `taskId`, `timeoutSec?`. Used when the agent decides it actually does need the result before continuing. |

The rule the prompt teaches the agent:

> Use a Task for anything you estimate will take more than ~30 seconds or
> >5 tool calls — refactors, multi-file edits, full-repo searches, builds,
> test runs, anything a subagent isn't enough for. Use the main turn for
> simple Q&A, single-file reads, status checks, anything quick.

### 2.3 Status lifecycle

```
        ┌─────────┐  task_start
        │ pending │ ──── (agent run begins) ────┐
        └────┬────┘                             │
             ▼                                  │
        ┌─────────┐                             │
        │ running │◀───── task_continue ────────┘
        └────┬────┘
   ┌─────────┼───────────────┬──────────────┐
   │         │               │              │
   ▼         ▼               ▼              ▼
succeeded  failed       cancelled       (terminal)
```

Each transition:
- Updates the thread-header checklist message.
- Posts a status line to the thread.
- For terminal states: posts a notification message in the parent channel
  (e.g. `📋 Task **Refactor auth** ✅ succeeded · 14 tool calls · 1m 47s`)
  with a link to the task thread. **No re-entry into `drainQueueAndRun`.**
  The next time the operator sends a message, the auto-injected
  `ACTIVE TASKS` block in the system prompt will tell the agent which
  tasks finished since the previous turn (and their summaries) so the
  agent can acknowledge them.

### 2.4 What goes into the task thread

Every task gets one Discord thread per task (created lazily when status →
running). The thread is the task's full transcript:

1. **Header message** (the message that started the thread) — edited in place
   with the checklist.
2. **Append-only messages** posted as the runtime emits callbacks:
   - `onToken`: streamed into a single live "💭 Reasoning…" message edited in
     place (reuse `StatusLine` pattern). Closed off at end of each LLM round.
   - `onToolStart` + `onToolResult`: posted as the existing `DetailThread`
     pattern (`source/discord/ui/progress-thread.ts`) — header + args block +
     result block per tool call.
   - Errors and the final assistant text post as their own messages.
3. **Terminal banner**: "✅ Task complete · 12 tool calls · 2m 14s" or
   "❌ Failed: <error>" or "⏹ Cancelled: <reason>".

### 2.5 The checklist

The agent maintains the checklist itself by calling a new `task_checklist` tool
*from inside the task* (not from the main agent — this is part of the task's own
toolset, alongside everything else). The tool takes an array of `{label, state:
'pending'|'doing'|'done'|'skipped'}`. The Task object holds the latest
checklist; the thread-header message is edited to render it.

If the task never calls `task_checklist`, the header just shows the title and
status.

This is intentionally separate from the existing in-memory `task_management`
todo system. That one is local to the agent's working memory; this one is the
*public* progress indicator visible to the operator.

---

## 3. Architecture

### 3.1 New module layout

```
source/discord/tasks/
├── task-types.ts          # Task, TaskStatus, ChecklistItem types
├── task-store.ts          # In-memory + JSON persistence of tasks
├── task-runner.ts         # Spawns runtime, wires callbacks to TaskThread
├── task-thread.ts         # Discord thread UI: header checklist + transcript
└── task-tools.ts          # task_start / task_status / task_interrupt /
                           # task_continue / task_wait / task_checklist
```

### 3.2 `Task` object

```ts
interface Task {
  id: string;                       // ulid or short uuid
  parentChannelId: string;          // where main conversation lives
  parentConversationId: string;     // for posting result messages back
  threadId: string | null;          // Discord thread for transcript (null until running)
  conversationId: string;           // task's own conversation in messageStore
  workingDirectory: string;         // ALWAYS inherited from parent at start time
  title: string;
  initialPrompt: string;
  status: TaskStatus;
  checklist: ChecklistItem[];
  toolCallCount: number;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  abortController: AbortController; // null after terminal
  headerMessageId: string | null;   // for in-place edits
  /** Set once the agent observes a terminal status via auto-inject */
  acknowledgedAt: number | null;
}
```

Persisted to `~/.local/share/derek/discord/tasks.json` so an in-flight task
survives a crash *as a record* — but **not** as a running process. On restart,
any task in `running` state is marked `failed` with reason "bot restarted".
This matches the current model: `runBackgroundTask` is also lost on restart.

### 3.3 The runner (`task-runner.ts`)

```ts
async function startTask(opts: {
  parentChannelId: string;
  parentGuildId?: string;
  parentConversationId: string;
  parentTriggerMessage: DiscordJsMessage;
  title: string;
  prompt: string;
  // NOTE: no workingDirectory — looked up from parent session
  runtime: HeadlessRuntime;
}): Promise<Task>
```

Steps:

1. Allocate `Task` with status `pending`. Working directory is read from the
   parent channel's `discordSessionStore` session.
2. Create Discord thread off `parentTriggerMessage`. Post header message
   (renders empty checklist + status).
3. Persist task (now has `threadId`, `headerMessageId`).
4. Fork session in `discordSessionStore`: clones working dir / mode / model
   from parent. The new conversationId is what `messageStore` keys against.
5. Transition to `running`. Edit header.
6. Fire-and-forget `runtime.processMessage(...)` with:
   - **Empty parent history**. The task only sees `prompt`.
   - `mode: 'auto-accept'` (no human approval — task tools never block on
     buttons). The main-channel session keeps its own mode.
   - Callbacks that funnel into `TaskThread` (see 3.4).
   - The task's own `AbortController.signal`.
7. On resolve: persist messages, transition to `succeeded`. On reject /
   abort: transition to `failed` or `cancelled`.
8. On terminal transition:
   - Update the thread's header message + post the terminal banner in the thread.
   - Post a notification in the parent channel (e.g.
     `📋 Task **<title>** ✅ succeeded · 14 tool calls · 1m 47s — see <thread>`).
   - **Do not** synthesise a `user` message into parent history.
   - **Do not** call `drainQueueAndRun`.

### 3.4 `TaskThread` (`task-thread.ts`)

Wraps the Discord ThreadChannel. Responsible for:
- Rendering the **header message** with title + status badge + checklist. Edits
  in place (throttled, like `StatusLine` / `QueuePrompt`).
- Reusing `DetailThread` for tool-call triplets (start header → args → result).
- Live-reasoning message: a single message edited in place by `onToken`
  callbacks, finalised when the LLM round ends.

Header rendering example:

```
🟢 **Refactor auth handlers** · running · 1m 04s

▸ Read existing handlers (3 files)
✓ Sketch new structure
○ Apply edits
○ Run tests
```

Status icons: 🟡 pending, 🟢 running, ✅ succeeded, ❌ failed, ⏹ cancelled.

### 3.5 Tool implementations

`task-tools.ts` exports tool definitions that follow the existing
`NanocoderToolExport` shape. Registration is **scope-specific**:

**Main-channel runs get:** `task_start`, `task_status`, `task_interrupt`,
`task_continue`, `task_wait`. Registered by the Discord gateway on top of
the standard tool set (the CLI runtime never sees these).

**Task runs (inside `processMessage` spawned by `task-runner`) get:**
`task_checklist` only. **None of the other task tools are exposed.**
A task cannot spawn a sub-task, inspect sibling tasks, cancel itself, or
wait on anything. It is a leaf unit of work. Flat depth, simpler mental
model, no accidental recursion.

The standard tool set (`read_file`, `execute_bash`, etc.) is of course
still available inside a task — it's only the task-management tools that
are withheld.

Implementation notes:

- `task_start` returns immediately with `{taskId, threadUrl}`. Does not block
  the main agent's turn.
- `task_wait` is the only tool that blocks. Implementation: subscribe to a task
  event-emitter, resolve when status hits a terminal state, reject on timeout
  with a partial-progress summary.
- `task_continue` reuses the *same* `messageStore` conversationId, appends the
  new prompt, and starts another `processMessage` round on the same Task object
  (status pending → running again).
- `task_interrupt` calls `task.abortController.abort(reason)`.
- `task_checklist` is a closure tool: its `execute` captures the specific
  `Task` object and updates `task.checklist`, which triggers a re-render of
  the thread-header message. Only added to `availableToolNames` for the
  task's own `processMessage` call, never globally registered. (Needs a
  small extension point in `HeadlessRuntime` — see §3.7.)

### 3.6 How the main agent learns about completed tasks

When the operator sends a message, the gateway runs `runAgentTurn` as today.
Before the system prompt is built, an injector reads the task store and
appends an `ACTIVE TASKS` section listing:

- Every non-terminal task in this channel: id, title, status, elapsed,
  tool-call count, checklist tail.
- Every terminal task in this channel where `acknowledgedAt < parent's
  last-turn timestamp` (i.e. tasks that finished since the agent last ran).
  After the turn completes, mark them all as acknowledged.

Example block:

```
ACTIVE TASKS in this channel
- task abc12 "Refactor auth" — 🟢 running · 2m 14s · 17 tool calls
  ▸ Apply edits to source/auth/login.ts
- task def45 "Run full test suite" — ✅ succeeded · 1m 03s · 8 tool calls
  Result: All 142 tests passed.
```

The agent is expected to acknowledge those in its reply ("the test task
finished and passed; refactor is still running").

### 3.7 Required `HeadlessRuntime` changes

Currently the runtime singleton-binds tools at `initialize` time, then every
`processMessage` call uses the same toolset. To inject `task_checklist` only
into a task's run, we need:

- `processMessage` to accept an optional `extraTools: NanocoderToolExport[]`
  param that's merged into `availableToolNames` and the tool registry **for
  that call only** (not globally).

That's the only required change. **No `process.chdir` work this round** —
tasks inherit parent cwd, so concurrent tasks rooted in the same channel all
share the same cwd, and chdir-during-run remains no worse than today.

### 3.8 What gets removed

- The `QueuePrompt` UI and both buttons (`background`, `swap_to_thread`).
- The `forkToThread` function.
- `handleQueueButton`.
- The `runBackgroundTask` helper and the `/task` slash command.
- The `state.queuePrompt` field on `ChannelRunState`.

### 3.9 What stays

- The per-channel state machine (`channelStates`, `ActiveRun`, `QueuedMessage`).
  Per-channel serialisation is still correct: the main conversation is a single
  thread of dialogue. We just stop using it as the *only* place work can happen.
- `drainQueueAndRun` — still the entry point for main-channel turns. Tasks
  no longer call it.
- `buildCombinedUserContent` — still combines queued messages.
- `replayMissedMessages` — unchanged.
- `messageStore`, `discordSessionStore.forkSession` — used by tasks.
- `DetailThread`, `StatusLine`, `formatToolStatus` — reused by `TaskThread`.
- `requestToolApproval` — only used by the main channel now (tasks are always
  auto-accept).
- `/stop` — extended: `scope: channel | all | task:<id>`.

---

## 4. Operator-visible behaviour changes

Before:
- Long task → channel locked → operator sees `⏸ Queue prompt: [Run in BG] [Move to thread]`.
- Or operator manually types `/task …` to start a fresh isolated run.

After:
- Operator says "refactor auth across the codebase".
- Main agent (in normal main-channel turn) calls `task_start({title: "Refactor auth", prompt: "..."})`.
  Replies inline: "Started task **Refactor auth** in `<thread>`. I'll let you know when it's done. Anything else?"
- Operator can keep chatting. Asks "what does this project do?" — main agent answers
  immediately from CLAUDE.md / VISION.md.
- Operator opens the thread to watch progress, sees the checklist tick over.
- Task completes → notification in main channel: "📋 Task **Refactor auth** ✅ succeeded · see <thread>."
- Next time the operator says anything in the main channel, the agent sees
  the auto-injected `ACTIVE TASKS` block showing the task succeeded since
  the last turn, and can naturally summarise / propose next steps.

---

## 5. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Tasks all share `process.cwd()` of the channel | Concurrent tasks under the same channel chdir together → fine. Cross-channel races already exist today. | Out of scope. Document that switching channel cwd while tasks are running is undefined. |
| Tasks with full parent history copied in could blow context | Slow, costly | Default: empty parent history. Add `inherit_context?: boolean` to `task_start` later if we want it. |
| Operator runs 10 tasks at once → 10 LLM streams over one client | Rate limits, cost | Soft cap: `MAX_CONCURRENT_TASKS = 3` per channel. `task_start` rejects with a "you have 3 running, finish or interrupt one" error. |
| Terminal-state ping arrives in main channel mid-operator-message | Confusing UX | The notification is just a Discord message; operator sees it as another message in scroll. Not a problem. |
| Agent forgets a task is running | Doesn't follow up | Auto-injected `ACTIVE TASKS` block makes this hard to forget. |
| Bot restarts while task is running | Task is dead but record says `running` | Startup pass: any `running` task → `failed` with reason "bot restarted before completion". Same fate `runBackgroundTask` has today (silent loss). Improvement over status quo. |
| Per-task model overrides via `runtime.setModel` | Mutates shared client | Out of scope for v1. All tasks use the channel's current model. |
| `task_checklist` not used by the agent at all | Header is bare | Acceptable. Header still shows status + tool count. The transcript thread is the source of truth. |
| Tool approval inside a task | Tasks should never block on a button | Tasks always run in `auto-accept` mode regardless of channel mode. Document this. |

---

## 6. Implementation phases

### ~~Phase 0 — Make `HeadlessRuntime` parallel-safe~~ (skipped in v2)

Tasks inherit parent cwd, so concurrent tasks under the same channel share
a cwd. Cross-channel races are out of scope (already exist today, no new
exposure). No tool changes needed.

### Phase 1 — Task plumbing (no UI yet)
- `task-types.ts`, `task-store.ts` (in-memory + JSON persistence).
- `task-runner.ts` skeleton: spawn runtime, wire to a stub `TaskThread`,
  no checklist yet.
- New tools: `task_start`, `task_status`, `task_interrupt`, `task_wait`.
  Wired into `processMessage`'s tool list **only when called via the Discord
  gateway** (not CLI).
- Test path: agent calls `task_start("test", "echo hello and stop")` → runs
  → status flips to `succeeded` → notification posts in parent channel.

### Phase 2 — Discord thread UI
- `TaskThread`: header message with status badge, in-place edits.
- Live reasoning message (StatusLine-style edits).
- DetailThread-style tool-call triplets.
- Terminal banner.

### Phase 3 — Checklist
- `task_checklist` closure tool registered into the task's own
  `processMessage` call.
- Header rendering includes the rendered checklist.
- Add `extraTools` param to `processMessage`.

### Phase 4 — Continuation + steering
- `task_continue`: re-runs `processMessage` against the same task session
  with new prompt.
- Test: interrupt a task, continue with different instructions, verify
  history is preserved and thread shows both rounds.

### Phase 5 — Remove old code + prompt updates
- Delete `forkToThread`, `runBackgroundTask`, `QueuePrompt`, queue-prompt
  buttons, `/task` slash command.
- Strip queue-prompt branches from `gateway.ts`. Queued messages just sit
  there until the active main-channel run finishes — no UI, no buttons.
- Update `/stop` to support `task:<id>`.
- Add a new prompt section `source/app/prompts/sections/discord-tasks.md`
  documenting when to use a task vs main turn. Wire it into Discord-runtime
  prompts only.
- Update `AGENTS.md` / docs.

### Phase 6 — Polish
- Per-channel concurrency cap (`MAX_CONCURRENT_TASKS = 3`, enforced in `task_start`).
- Bot-restart cleanup pass (mark `running` tasks as `failed` with reason
  "bot restarted before completion").
- Extend `/stop` with `scope: task:<id>` for operator emergency-abort.
- Auto-inject `ACTIVE TASKS` block into every main-channel turn's system
  prompt (lists non-terminal tasks + tasks that finished since last turn,
  and marks the latter as `acknowledged` after the turn).

---

## 7. Decisions (locked in)

1. **Fully agentic.** No `/task_start`, `/task`, `/tasks` slash commands for
   operator control. The agent owns the lifecycle: starting, interrupting,
   continuing. Operator just chats in the main channel; if they want to
   redirect a task, they say so and the agent calls `task_interrupt` +
   `task_continue`. The only operator-facing slash command for tasks is
   `/stop` (extended) for emergency abort.
2. **Auto-inject task summary into every main-channel turn's system prompt.**
   Lists non-terminal tasks plus terminal tasks that completed since the
   agent last ran. Marks them acknowledged after the turn so they only
   appear once.
3. **Tasks always inherit parent cwd. No override.** New project → new
   channel.
4. **Task sub-tasks: not in v1.** Tasks run in auto-accept and have the full
   normal tool set, so technically they *could* call `task_start` themselves.
   Decision: omit `task_start` (and the other task tools) from the toolset
   registered into a task's own `processMessage` call. Flat depth until we
   see real demand.
5. **`task_continue` cannot change working directory.** New cwd → new task.
6. **No synthetic-message-into-parent-history.** Tasks notify only by
   posting a Discord message in the parent channel. Main agent learns the
   detail via the auto-inject block on its next real turn.
7. **`task_status` payload shape:**
   ```
   Task abc12 "Refactor auth handlers"
   Status: running · 2m 14s · 17 tool calls
   Checklist:
     ✓ Read existing handlers
     ▸ Applying edits
     ○ Run tests
   Last activity:
     [2m 03s] tool: write_file source/auth/login.ts
     [2m 08s] tool: write_file source/auth/logout.ts
     [2m 12s] assistant: "Updated login and logout. Running tests next…"
   ```
   Bounded: max 10 most recent transcript entries, each truncated to ~200
   chars. Without `taskId` → list view (status + title only).

## 8. Removed operator surface

For the record, the post-implementation operator surface for anything
task-related:

- **No** `/task` slash command.
- **No** queue-prompt buttons.
- **No** `/tasks` list command.
- Task threads are still visible in Discord — operator can open them to watch
  progress live. That's the whole UX for observing tasks.
- `/stop` gains a `task:<id>` scope option so operator can emergency-abort a
  specific task if the agent won't.
- Everything else (start, continue, interrupt-for-new-direction) happens by
  talking to the agent.

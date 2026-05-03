# Plan v3: Tasks use a single live status message, not a thread

## 1. What changed your mind

Two findings from the first end-to-end smoke test:

- **Threads don't carry their weight.** The task thread showed reasoning
  bubbles, tool-call triplets, and a header checklist. In practice the
  tool-call transcript was noisy and rarely useful to read — the *summary*
  (status + checklist + final output) was what mattered. The cost of a
  thread (extra Discord object, extra navigation, can't be read in-context
  next to the rest of the conversation) isn't justified by what it
  actually conveys.
- **Thread creation is fragile under parallelism.** Two concurrent
  `task_start` calls in one turn → both hit "Could not create Discord
  thread for task". Likely Discord rate-limiting or a per-channel
  concurrent-thread-create ceiling. Removing threads removes this
  failure mode entirely.

Replacing the thread with **a single parent-channel message edited in
place** is both simpler and more useful.

## 2. New UX

When the agent calls `task_start`:

1. A new message is posted in the parent channel:
   ```
   🟢 **Refactor auth handlers** · running · 3s · `task abc12`
   ○ Read existing handlers
   ○ Sketch new structure
   ○ Apply edits
   ○ Run tests
   ```
2. That same message gets **edited in place** as the task runs — status
   badge flips, elapsed time ticks, checklist items change state, tool
   count updates.
3. On terminal transition the message shows the final state and any error
   or one-line summary. No separate "terminal banner" sent as a
   follow-up message.

   ```
   ✅ **Refactor auth handlers** · succeeded · 1m 47s · 14 tool calls · `task abc12`
   ✓ Read existing handlers
   ✓ Sketch new structure
   ✓ Apply edits
   ✓ Run tests

   Result: Refactored 4 handlers in source/auth/. Tests pass.
   ```

That's the entire visible UX. No thread. No tool-call triplets. No live
reasoning bubble.

## 3. What the operator can no longer do

- See the per-tool-call transcript live
- Follow reasoning token-by-token
- Continue the task from inside the thread (there isn't one)

If the operator wants detail, they ask the agent (who can `task_status`
and surface the last 10 activity entries from memory). This matches what
they already do for most tool calls in the main channel anyway — they
trust the agent and read the summary.

## 4. Architecture changes

All the plumbing stays; only the UI layer changes.

### 4.1 Files that change

**`source/discord/tasks/task-thread.ts` → rename to `task-status-message.ts`**

- Drop: `DetailThread` integration (tool-call triplets), reasoning-bubble
  streaming (`onToken`), `postTerminalBanner` as a separate post.
- Keep: `renderTaskHeader` (now renders the *whole* message body), the
  throttled in-place edit loop, the 5-second elapsed-time refresh tick.
- Rename: `TaskThread` → `TaskStatusMessage`.
- Replace `TaskThread.create(triggerMessage, task)` with
  `TaskStatusMessage.create(channel, task)` — takes a `TextChannel`
  or `ThreadChannel` (the parent channel) directly. No longer opens
  a thread.
- Remove `postParentNotification` entirely — the status message *is*
  the notification. Terminal state is visible by status badge + elapsed
  freezing + final-output line.
- `reattach(channel, task, messageId)` for continuation: fetch the
  existing status message by id, wrap in a fresh `TaskStatusMessage`
  for another edit cycle.

### 4.2 `task-types.ts`

- Rename `threadId` → `statusChannelId` (the channel the status message
  lives in — same as `parentChannelId` in practice, but keep it
  explicit for future flexibility).
- Rename `headerMessageId` → `statusMessageId`.
- Old field names get migrated by the store on load (best-effort — see
  §4.6).

### 4.3 `task-runner.ts`

- `startTask` no longer calls `triggerMessage.startThread`. Instead
  calls `TaskStatusMessage.create(triggerChannel, task)` — where
  `triggerChannel` is `triggerMessage.channel` (`TextChannel |
  ThreadChannel`). Works anywhere a message was sent, including
  inside an existing thread.
- Error message changes from "Could not create Discord thread for
  task" to "Could not post status message for task".
- `driveTask`'s runtime callbacks:
  - `onToken` → **removed** from status-message calls. Tasks no longer
    stream reasoning into Discord. (Tokens still accumulate in the
    runtime's own buffer for the final-response, which lands in the
    status message's "Result:" line.)
  - `onToolStart` / `onToolResult` → no longer call `DetailThread`.
    They still update the activity log and increment tool count
    (which drives the header re-render via `updateTask`).
- `continueTask`: fetches the status message by id instead of the
  thread; reuses `TaskStatusMessage.reattach(channel, task, messageId)`.
  Posts a one-line "▶ Continuing with new instructions: …" reply in
  the parent channel (not the thread) so the operator sees the turn
  boundary, then updates the status message as the new run progresses.

### 4.4 `task-status-message.ts` render

The message body grows slightly to include everything the thread used
to carry in its header + terminal banner:

```
<status-emoji> **<title>** · <status> · <elapsed>[ · N tool calls] · `task <id>`
<optional: checklist, one per line>

[optional "Result:" line on success, final assistant text truncated to ~1500 chars]
[optional "Error:" line on failure]
[optional "Cancelled:" line]
```

Discord per-message limit is 2000 chars. We truncate the final result
aggressively (~1500 chars) to stay under, with "…(truncated)" marker.
If the agent produces longer output that the operator needs to see in
full, they ask for it in the main channel (the full response is in
task.lastResponse).

### 4.5 Delete

- `source/discord/ui/progress-thread.ts` (`DetailThread`) is no longer
  used by tasks. Check for other callers first:
  - grep: was only used by `forkToThread` (already removed) and
    `TaskThread`. If no other callers, delete it.

### 4.6 Migration of existing task records

Any pre-v3 tasks in `~/.local/share/derek/discord/tasks.json` have
`threadId` / `headerMessageId` fields. On load in `TaskStore.initialize`:
- If record has `threadId` but no `statusChannelId`, copy
  `threadId → statusChannelId` and `headerMessageId → statusMessageId`.
- Tasks that were running at the time of the refactor are already
  marked failed by the restart-cleanup pass, so they don't need a
  working thread/message handle.

(In practice there's probably one or two records from smoke-testing.
If migration is noisy, just wipe the file — zero production data.)

## 5. What does NOT change

- `task_start` / `task_status` / `task_interrupt` / `task_continue` /
  `task_wait` / `task_checklist` — all six tool signatures unchanged.
- Task lifecycle: pending → running → succeeded/failed/cancelled.
- Persistence layout (minus the two renamed fields).
- `ACTIVE TASKS` auto-inject into main-channel turns.
- Parent-cwd inheritance.
- Task-management tool exclusion inside tasks (no sub-tasks).
- Concurrency cap per channel (3).
- `/stop task:<id>`.
- Restart-cleanup (running → failed on boot).

## 6. Risks

| Risk | Mitigation |
|---|---|
| Status-message edit rate-limiting: checklist updates + elapsed ticks + tool-count bumps could easily exceed Discord's ~5 edits/5s per message | Already throttled to 1 edit/sec via `HEADER_EDIT_THROTTLE_MS`. Keep that. Consider bumping to 2s if we hit rate limits in practice. |
| Status message gets truncated by the 2000-char Discord limit (long titles + long checklist + long result) | Truncate the "Result:" section aggressively (1500 chars). Clamp checklist item labels to 100 chars each and cap at, say, 15 items — beyond that the task is too fine-grained. |
| Losing the tool-call transcript removes a debug surface | The activity log in `task_status` still captures the last 30 entries; the agent can surface them on request. Good enough for debugging. |
| Operator misses terminal transition (no ping) | The in-place edit is visible in scrollback and the status badge + elapsed-time freeze signal done-ness. Discord doesn't ping on edits, but also doesn't on the old thread terminal banner. Net neutral. |
| `continueTask` needs to fetch the old status message; it might have been deleted | Fall back to posting a *new* status message in the same channel. Log a console warning. |

## 7. Implementation order

Small enough that a single commit is fine. Rough sequence:

1. Rename `task-thread.ts` → `task-status-message.ts`; rename the class.
2. Strip DetailThread, onToken, postTerminalBanner. Expand
   `renderTaskHeader` to include optional Result/Error sections.
3. Change `create()` signature to take a channel directly; drop
   `startThread` call.
4. Update `task-runner.ts`:
   - `startTask`: `TaskStatusMessage.create(triggerMessage.channel, task)`
   - Runtime callbacks: drop onToken, drop DetailThread calls
   - `continueTask`: reattach against channel + statusMessageId
5. Update `task-types.ts` field names + migration in `task-store.initialize`.
6. Delete `progress-thread.ts` if no other callers.
7. Build; fix typecheck errors.
8. Restart derek-dev; try the test prompt again (five file reads);
   verify: single status message, updates in place, no threads.
9. Test parallel `task_start` works (the original motivating failure).

## 8. Open questions

1. **Where does the status message live when the operator is in a
   thread?** Options:
   - Same channel the trigger message was in (= the thread). Status
     messages pile up in the thread. Probably fine.
   - Always the top-level channel. Harder to correlate, skip.
   Recommend: same channel as trigger.
2. **Should the final result be in the status message or a separate
   follow-up?** v3 proposes in-message. If the operator wants a
   pingable summary, they can ask the agent to repeat it.
3. **What does the agent see in `task_status` for the thread URL?**
   Before: Discord deep-link to the thread. After: a jump link to the
   status message (`https://discord.com/channels/<guild>/<channel>/<msg>`).
   Still useful.

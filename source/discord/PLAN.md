# Derek Discord Bot — Architecture Plan

## Summary

Discord adapter inside the Derek project. Each Discord channel/thread = a session.
The bot uses Derek's existing AI client, tool system, and prompt builder — but
bypasses the Ink terminal UI with a headless runtime.

## Key Decisions

- **Shared session per channel** — everyone in a channel shares context
- **No role-based access control** — guild/channel allowlists in env only
- **Flexible working directory** — configurable per session via `/new`
- **Foreground process** — use systemd/Docker/pm2 for always-on
- **Plank is reference only** — completely separate bot tokens and servers
- **discord.js v14** — for slash commands, threads, buttons, embeds, rate limiting

## Discord ↔ Session Mapping

| Discord Surface        | Derek Session      | Behaviour                                  |
|------------------------|--------------------|--------------------------------------------|
| Text channel           | 1 per channel      | Long-lived, persists across restarts       |
| Thread (from /fork)    | 1 per thread       | Forked copy of parent at creation time     |
| DM channel             | 1 per DM           | Private session                            |

Conversation ID format: `discord:guild:{guildId}:channel:{channelId}` or `discord:dm:{channelId}`

## Thread Strategy for Long Tasks

When Derek hits 3+ tool calls for a single user message:
1. Bot creates a thread off the triggering message
2. Thread first message = editable progress embed (updated in-place)
3. Tool outputs posted as subsequent thread messages
4. Main channel gets final summary when done
5. User can ask questions in the thread while it runs

## Message Flow

```
User message in channel
  → filter (bots, allowlist, @mention requirement)
  → resolve conversationId from channel/thread ID
  → load/create session + message history
  → send "💭 Thinking..." message
  → HeadlessRuntime.processMessage()
    → build system prompt (reuses Derek's prompt-builder)
    → get tools from ToolManager (filtered by mode)
    → call AISDKClient.chat() with streaming
    │  → stream tokens → buffer → edit Discord message every ~1.5s
    │  → on tool calls:
    │      → if auto-approved: execute, append result, continue loop
    │      → if needs approval: post embed with ✅/❌ buttons, wait
    │      → recurse until no more tool calls
    → final response → split at 2000 char boundaries → send
    → save messages
```

## Slash Commands

| Command                      | Description                                    |
|------------------------------|------------------------------------------------|
| `/new [cwd] [model] [provider]` | Fresh session in this channel               |
| `/fork [name]`               | Fork session into a new thread                 |
| `/status`                    | Session info: model, provider, mode, messages  |
| `/model <name>`              | Switch model                                   |
| `/provider <name>`           | Switch provider                                |
| `/clear`                     | Clear conversation history                     |
| `/compact`                   | Compress context                               |
| `/mode <normal|auto-accept|yolo>` | Set tool approval mode                   |
| `/sessions`                  | List recent sessions                           |

## Tool Approval (normal mode)

Posted as Discord message with buttons:
- ✅ Approve — execute this tool
- ❌ Reject — skip, tell LLM it was rejected
- ✅ Approve All — switch to auto-accept for rest of turn
- 5 minute timeout → auto-reject

## File Structure

```
derek/source/discord/
├── PLAN.md                       # This file
├── bot.ts                        # Entry: init discord.js, register commands, start gateway
├── gateway.ts                    # messageCreate + interactionCreate handlers
├── config.ts                     # Load env vars
├── types.ts                      # Type definitions
├── commands/
│   └── registry.ts               # Slash command definitions + registration
├── runtime/
│   ├── headless-runtime.ts       # Core conversation loop (imperative, no React)
│   └── tool-approval.ts          # Button-based approve/reject
├── session/
│   ├── discord-session.ts        # Channel/thread ↔ session mapping
│   └── message-store.ts          # Per-conversation message persistence
└── ui/
    ├── message-formatter.ts      # Format output for Discord
    ├── message-splitter.ts       # Smart split at 2000 char boundaries
    └── progress-thread.ts        # Auto-threads + progress tracking
```

## Modified Existing Files

| File                   | Change                                                      |
|------------------------|-------------------------------------------------------------|
| `derek/source/cli.tsx` | Added `discord` subcommand that bypasses Ink                |
| `derek/package.json`   | Added `discord.js` dependency                               |
| `derek/.env.example`   | Added `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, etc.   |

## Env Vars Required

| Variable                     | Required | Description                                    |
|------------------------------|----------|------------------------------------------------|
| `DISCORD_BOT_TOKEN`         | Yes      | Discord bot token                              |
| `DISCORD_APPLICATION_ID`    | Yes      | Discord application/client ID                  |
| `DISCORD_GUILD_IDS`         | No       | Comma-separated guild allowlist (empty = all)  |
| `DISCORD_ALLOWED_CHANNEL_IDS` | No     | Comma-separated channel allowlist (empty = all)|
| `DISCORD_WORKING_DIRECTORY` | No       | Default working directory (defaults to cwd)    |

Plus the existing provider env vars (e.g. `OPENROUTER_API_KEY`).

## Running

```bash
cd derek
derek discord
derek discord --provider openrouter --model google/gemini-3.1-flash
```

## Implementation Status

- [x] discord.js dependency + env vars
- [x] config.ts
- [x] types.ts
- [x] session/discord-session.ts
- [x] session/message-store.ts
- [x] ui/message-splitter.ts
- [x] ui/message-formatter.ts
- [x] ui/progress-thread.ts
- [x] runtime/headless-runtime.ts
- [x] runtime/tool-approval.ts
- [x] commands/registry.ts
- [x] gateway.ts (message handling + slash commands + streaming + threads)
- [x] bot.ts (entry point)
- [x] cli.tsx modified (discord subcommand)
- [ ] Build verification
- [ ] Fix any type/import errors

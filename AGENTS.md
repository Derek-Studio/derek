# AGENTS.md — Derek

AI context for the **Derek** project. Loaded at runtime by Derek and by Claude Code (via `CLAUDE.md`).

## What This Project Is

Derek is a persistent AI coding agent that runs as:
- A **Discord bot** — always-on, channel-aware, supports parallel background tasks
- An interactive **CLI tool** — same agent, terminal interface

Built on [Nano Collective's nanocoder](https://github.com/Nano-Collective/nanocoder), maintained at [Derek-Studio/derek](https://github.com/Derek-Studio/derek).

**Stack:** TypeScript, React 19, Ink.js (CLI), discord.js v14, Vercel AI SDK, pnpm

---

## Two-Worktree Setup

The repo runs as **two simultaneous instances** via git worktrees:

| Worktree | Path | Branch | Service | Discord channel |
|---|---|---|---|---|
| Production | `/root/projects/derek` | `dev` | `derek-discord` | `#derek` |
| Dev/staging | `/root/projects/derek-dev` | feature branch | `derek-dev-discord` | `#derek-test` |

Both worktrees share one git repo (`git worktree list` to verify). Never manually copy files between them — use git to merge branches.

**Shared config:** `/root/.config/derek/` (channels.json, .env for prod)
**Dev config:** `/root/.config/derek-dev/` (.env with separate bot token)

---

## Deploying

Always use the safe deploy script — never restart the service or run `systemctl` directly:

```bash
pnpm run deploy
```

`scripts/safe-deploy.sh` does:
1. Backs up `dist/` → `dist.bak/`
2. Builds (`tsc && tsc-alias`)
3. Restarts the service (auto-detected from worktree path)
4. Watches for 15s — if the service crashes, auto-restores `dist.bak/` and brings the old version back
5. If build fails, the service is never restarted (old version keeps running)

---

## Self-Modification Protocol

When modifying this codebase:

1. **Work in the dev worktree** (`/root/projects/derek-dev`) on a feature branch — never edit `dev` directly.

2. **Create a branch first:**
   ```bash
   git checkout -b self-mod/YYYY-MM-DD-description
   ```

3. **Type-check after each file edit** (fast feedback):
   ```bash
   pnpm run test:types
   ```

4. **Run the full suite before deploying:**
   ```bash
   pnpm run test:all      # format, types, lint, AVA tests, knip, audit
   ```

5. **Deploy to the dev bot** — auto-rollback protects against crashes:
   ```bash
   pnpm run deploy
   ```

6. **Test via `#derek-test`** in Discord.

7. **Discord tasks auto-merge** their branch to `dev` on success. For manual work, notify the user with the branch name — they will merge and run `pnpm run deploy` in `/root/projects/derek` to promote to production.

---

## Development Commands

```bash
# Build
pnpm run build              # Compile TypeScript → dist/

# Deploy (always prefer over raw systemctl)
pnpm run deploy             # Safe deploy with auto-rollback

# Testing
pnpm run test:all           # Full suite
pnpm run test:types         # TypeScript only (fast, run after each edit)
pnpm run test:ava           # Unit tests only
pnpm run test:ava source/path/to/file.spec.ts  # Single test file
pnpm run test:ava:coverage  # Tests with coverage report
pnpm run test:lint:fix      # Auto-fix lint/format issues

# Dev watch mode
pnpm run dev                # tsc --watch

# VS Code extension
pnpm run build:vscode       # Build to assets/derek-vscode.vsix
```

---

## Repo Layout

```
source/
  app/               # App entry, state, prompts, system prompt sections
  discord/           # Discord bot: gateway, tasks, session, UI
    tasks/           # Task system — worktree-manager.ts, tool-cwd-context.ts
  tools/             # Built-in tools (file ops, bash, search, git, web)
  commands/          # CLI slash commands (/model, /clear, etc.)
  custom-commands/   # User-defined markdown commands
  ai-sdk-client/     # LLM client, chat handler, streaming
  config/            # Config loading, theme
  mcp/               # Model Context Protocol server integration
  hooks/             # React hooks (state, chat, tools, modes)
  components/        # Ink UI components
scripts/
  safe-deploy.sh     # Build + restart with auto-rollback
  test.sh            # Full test suite runner
source/app/prompts/sections/   # System prompt markdown sections
```

---

## Architecture

**Entry points:**
- `source/cli.tsx` → CLI (React/Ink render of `source/app.tsx`)
- `source/discord/bot.ts` → Discord bot initialisation
- `source/discord/gateway.ts` → Message routing, session management (core logic)

**Application flow:**
1. Directory trust check (`useDirectoryTrust`) — first-run disclaimer for new directories
2. App initialisation (`useAppInitialization`) — creates LLM client, loads MCP servers, loads custom commands
3. Central state (`useAppState`) — single source of truth for all state
4. Chat/tool flow — user input → LLM → tool confirmation → execution → response

**State:** All CLI state lives in `source/hooks/useAppState.tsx`. Other hooks (`useChatHandler`, `useToolHandler`, `useModeHandlers`) receive state/setters from it.

**Tool system:** Registered in `source/tools/tool-manager.ts` with:
- `handler` — executes the tool
- `nativeTool` — AI SDK schema definition
- `formatter` — formats output for display
- `validator` — pre-execution validation (optional)

File editing uses a content-based approach: `string_replace` (primary, replaces exact content), `write_file` (whole-file overwrites).

**Command system:** Slash commands in `source/commands/`, lazy-loaded via `source/commands/lazy-registry.ts`. To add a command: create a file exporting a `Command` object, add an entry to `lazyCommands`. Commands that need app state are intercepted in `source/app/utils/app-util.ts`.

**System prompt:** Assembled in `source/utils/prompt-builder.ts` from markdown section files in `source/app/prompts/sections/`. Project context files (`AGENTS.md`, `VISION.md`, `TODO.md`) are appended from the current working directory.

**Discord tasks:** Long-running work runs in isolated git worktrees (`/tmp/derek-tasks/<nonce>/`) on branches `task/<nonce>`. Tasks auto-merge to `dev` on success. See `source/discord/tasks/`.

**Config resolution order:**
1. `agents.config.json` in working directory
2. `~/.config/derek/agents.config.json`
3. `~/.agents.config.json`

---

## Code Style

- **Formatter/linter:** Biome (tabs, single quotes, semicolons, trailing commas)
- **TypeScript strict mode** with `@/*` → `source/*` path alias
- **No unused variables or imports** (`noUnusedVariables: error`, `noUnusedImports: error`)
- **React 19** with Ink.js for CLI rendering
- **Pre-commit hook** runs lint-staged on every commit

---

## Testing

- **Framework:** AVA with tsx loader
- **Location:** `source/**/*.spec.ts` alongside source files
- **Serial execution** (no parallel threads)
- **Coverage threshold:** 80% lines (c8)
- Note: Discord layer (`source/discord/`) currently has no test coverage

---

## Development Modes

Toggle with Shift+Tab during a chat session:
- **normal** — confirm each tool before execution
- **auto-accept** — auto-execute most tools (bash and destructive git still prompt)
- **yolo** — auto-execute everything without exception
- **plan** — show tool calls but don't execute

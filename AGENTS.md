# AGENTS.md — Derek (Dev Worktree)

AI context for the **Derek** project — dev/staging worktree. Loaded at runtime by the dev bot.

This worktree (`/root/projects/derek-dev`, branch `feat/task-worktrees-v2`) is the staging environment for self-modification. Changes are tested here before being merged to production (`/root/projects/derek`, branch `dev`).

## What This Project Is

Derek is a persistent AI coding agent that runs as:
- A **Discord bot** — always-on, channel-aware, supports parallel background tasks
- An interactive **CLI tool** — same agent, terminal interface

Built on [Nano Collective's nanocoder](https://github.com/Nano-Collective/nanocoder), maintained at [Derek-Studio/derek](https://github.com/Derek-Studio/derek).

**Stack:** TypeScript, React 19, Ink.js (CLI), discord.js v14, Vercel AI SDK, pnpm

---

## Two-Worktree Setup

| Worktree | Path | Branch | Service | Discord channel |
|---|---|---|---|---|
| Production | `/root/projects/derek` | `dev` | `derek-discord` | `#derek` |
| Dev/staging | `/root/projects/derek-dev` | `feat/task-worktrees-v2` | `derek-dev-discord` | `#derek-test` |

Both share one git repo (`git worktree list` to verify). Never manually copy files between them — use git to merge branches.

**Shared config:** `/root/.config/derek/` (channels.json, .env for prod)
**Dev config:** `/root/.config/derek-dev/` (.env with separate bot token)

---

## Deploying

Always use the safe deploy script — never restart the service directly:

```bash
pnpm run deploy
```

`scripts/safe-deploy.sh` does:
1. Backs up `dist/` → `dist.bak/`
2. Builds (`tsc && tsc-alias`)
3. Restarts `derek-dev-discord`
4. Watches for 15s — if the service crashes, auto-restores `dist.bak/` and brings the old version back
5. If build fails, the service is never restarted

---

## Self-Modification Protocol

This is the staging worktree — all self-mod work happens here first.

1. **Create a branch** off the current branch:
   ```bash
   git checkout -b self-mod/YYYY-MM-DD-description
   ```

2. **Type-check after each file edit:**
   ```bash
   pnpm run test:types
   ```

3. **Run the full suite before deploying:**
   ```bash
   pnpm run test:all
   ```

4. **Deploy to the dev bot** (safe deploy, auto-rollback on crash):
   ```bash
   pnpm run deploy
   ```

5. **Test via `#derek-test`** in Discord — the dev bot runs from this worktree.

6. **When satisfied, notify the user** with the branch name. Do NOT merge to `dev` yourself. The user will merge and run `pnpm run deploy` in `/root/projects/derek` to promote to production.

---

## Development Commands

```bash
pnpm run build              # Compile TypeScript → dist/
pnpm run deploy             # Safe deploy with auto-rollback
pnpm run test:all           # Full suite
pnpm run test:types         # TypeScript only (fast, run after each edit)
pnpm run test:ava           # Unit tests only
pnpm run test:ava source/path/to/file.spec.ts
pnpm run test:lint:fix      # Auto-fix lint/format issues
pnpm run dev                # tsc --watch
```

---

## Repo Layout

```
source/
  app/               # App entry, state, prompts, system prompt sections
  discord/           # Discord bot: gateway, tasks, session, UI
    tasks/           # Task system — includes worktree-manager.ts (this branch)
  tools/             # Built-in tools (file ops, bash, search, git, web)
  commands/          # CLI slash commands
  ai-sdk-client/     # LLM client, chat handler, streaming
  config/            # Config loading, theme
  mcp/               # MCP server integration
  hooks/             # React hooks
  components/        # Ink UI components
scripts/
  safe-deploy.sh     # Build + restart with auto-rollback
source/app/prompts/sections/   # System prompt markdown sections
```

---

## What's Different on This Branch

`feat/task-worktrees-v2` adds git worktree isolation for parallel Discord tasks:

- `source/discord/tasks/worktree-manager.ts` — creates/removes per-task git worktrees at `/tmp/derek-tasks/<taskId>/`
- `source/discord/tasks/tool-cwd-context.ts` — threads cwd through AsyncLocalStorage so all tools resolve against the task's worktree, not `process.cwd()`
- Modified: `task-runner.ts`, `task-store.ts`, `task-types.ts`, `headless-runtime.ts`, `gateway.ts`

Each `/task` started in Discord gets its own isolated branch and worktree — parallel tasks can't step on each other's files.

---

## Code Style

- **Formatter/linter:** Biome (tabs, single quotes, semicolons, trailing commas)
- **TypeScript strict mode** with `@/*` → `source/*` path alias
- **No unused variables or imports**
- Pre-commit hook runs lint-staged on every commit

---

## Testing

- **Framework:** AVA with tsx loader
- **Location:** `source/**/*.spec.ts` alongside source files
- **Serial execution**, 80% line coverage threshold
- Note: Discord layer (`source/discord/`) currently has no test coverage

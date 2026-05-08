# AGENTS.md — Derek

AI coding agent context for the **Derek** project. This file is loaded into Derek's system prompt at runtime.

## What This Project Is

Derek is a persistent AI coding agent that runs as:
- A **Discord bot** — always-on, channel-aware, supports parallel background tasks
- An interactive **CLI tool** — same agent, terminal interface

Built on [Nano Collective's nanocoder](https://github.com/Nano-Collective/nanocoder), maintained at [Derek-Studio/derek](https://github.com/Derek-Studio/derek).

**Stack:** TypeScript, React 19, Ink.js (CLI), discord.js v14, Vercel AI SDK, pnpm

---

## Repo Layout

```
source/
  app/               # App entry, state, prompts, system prompt sections
  discord/           # Discord bot: gateway, tasks, session, UI
  tools/             # Built-in tools (file ops, bash, search, git, web)
  commands/          # CLI slash commands (/model, /clear, etc.)
  custom-commands/   # User-defined markdown commands
  ai-sdk-client/     # LLM client, chat handler, streaming
  config/            # Config loading, theme
  mcp/               # Model Context Protocol server integration
  hooks/             # React hooks (state, chat, tools, modes)
  components/        # Ink UI components
scripts/
  safe-deploy.sh     # Build + restart with auto-rollback (use this, not raw systemctl)
  test.sh            # Full test suite runner
source/app/prompts/sections/   # System prompt markdown sections (22 files)
```

---

## Two-Worktree Setup

The repo runs as **two simultaneous instances** via git worktrees:

| Worktree | Path | Branch | Service | Discord channel |
|---|---|---|---|---|
| Production | `/root/projects/derek` | `dev` | `derek-discord` | `#derek` |
| Dev/staging | `/root/projects/derek-dev` | `feat/task-worktrees-v2` | `derek-dev-discord` | `#derek-dev-test` |

Both worktrees share one git repo. You can verify with:
```bash
git worktree list
```

**Shared config:** `/root/.config/derek/` (channels.json, .env for prod)
**Dev config:** `/root/.config/derek-dev/` (.env with separate bot token)

---

## Deploying

Always use the safe deploy script — never restart the service directly:

```bash
pnpm run deploy          # build + restart with auto-rollback
```

`scripts/safe-deploy.sh` does:
1. Backs up `dist/` → `dist.bak/`
2. Builds (`tsc && tsc-alias`)
3. Restarts the service
4. Watches for 15s — if the service crashes, auto-restores `dist.bak/` and restarts the old version
5. If build fails, service is never restarted (old version keeps running)

The script auto-detects the target service from the worktree path.

---

## Self-Modification Protocol

When modifying this codebase (including self-modification):

1. **Create a branch first** — never edit `dev` or `main` directly:
   ```bash
   git checkout -b self-mod/YYYY-MM-DD-description
   ```

2. **Type-check after each file edit:**
   ```bash
   pnpm run test:types
   ```

3. **Run full test suite before deploying:**
   ```bash
   pnpm run test:all      # format, types, lint, AVA tests, knip, audit
   ```

4. **Deploy with safe deploy** (not raw build + restart):
   ```bash
   pnpm run deploy
   ```
   If the new version crashes, it auto-rolls back to the previous build.

5. **Never self-merge to `dev` or `main`** — leave that for the human operator.

6. **Test in the dev worktree first** when the change is risky or behavioural. The dev bot runs independently; if it breaks, production is unaffected.

---

## Development Commands

```bash
# Build
pnpm run build              # Compile TypeScript → dist/

# Deploy (always prefer this over raw systemctl)
pnpm run deploy             # Safe deploy with auto-rollback

# Testing
pnpm run test:all           # Full suite
pnpm run test:types         # TypeScript only (fast, run after each edit)
pnpm run test:ava           # Unit tests only
pnpm run test:ava source/path/to/file.spec.ts  # Single test file
pnpm run test:lint:fix      # Auto-fix lint/format issues

# Dev watch mode
pnpm run dev                # tsc --watch
```

---

## Key Architecture Points

**Entry points:**
- `source/cli.tsx` → CLI (React/Ink render)
- `source/discord/bot.ts` → Discord bot
- `source/discord/gateway.ts` → Message routing, session management

**State:** All CLI state lives in `source/hooks/useAppState.tsx`. Other hooks receive state/setters from it.

**Tools:** Registered in `source/tools/tool-manager.ts` with handler, nativeTool (AI SDK schema), formatter, and optional validator.

**System prompt:** Assembled in `source/utils/prompt-builder.ts` from 22 markdown section files in `source/app/prompts/sections/`. Project context files (this file, VISION.md, TODO.md, CLAUDE.md) are appended at the end.

**Discord tasks:** Long-running work runs as background tasks with isolated context. Each task gets a live status message in Discord. See `source/discord/tasks/`.

**Config resolution:**
1. `agents.config.json` in working directory
2. `~/.config/derek/agents.config.json`
3. `~/.agents.config.json`

---

## Code Style

- **Formatter/linter:** Biome (tabs, single quotes, semicolons, trailing commas)
- **TypeScript strict mode** with `@/*` → `source/*` path alias
- **No unused variables or imports** (enforced)
- **React 19** with Ink.js for CLI rendering
- Pre-commit hook runs lint-staged on every commit

---

## Testing

- **Framework:** AVA with tsx loader
- **Location:** `source/**/*.spec.ts` alongside source files
- **Serial execution** (no parallel threads)
- **Coverage threshold:** 80% lines (c8)
- Note: Discord layer (`source/discord/`) currently has no test coverage

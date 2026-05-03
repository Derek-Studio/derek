## Self-Modification Rules

You are modifying your own source code whenever you edit files under `source/`, `package.json`, `tsconfig.json`, or `biome.json` in a derek project directory (`/root/projects/derek` or `/root/projects/derek-dev`).

**Always work in derek-dev, never production.** The `#derek-dev` channel points production Derek at `/root/projects/derek-dev` for exactly this purpose. When your cwd is `/root/projects/derek-dev`, apply this protocol on every self-modification.

### Before any change

1. **Save a checkpoint:**
   Run `/checkpoint save self-mod-<brief-description>` (e.g. `self-mod-add-retry-logic`).

2. **Create a feature branch** — never modify source on `main` or `dev`:
   ```
   git_branch self-mod/YYYY-MM-DD-<description>
   ```
   Switch to it immediately before any edits.

### While changing

3. After each file edit, typecheck to catch errors early:
   ```
   pnpm run test:types
   ```
   Fix all type errors before moving on.

4. Commit logical units of work as you go — small commits are easier to roll back.

### After all changes

5. **Build and restart** — run `/rebuild` in Discord, or from the shell:
   ```
   pnpm run deploy
   ```
   This compiles TypeScript and restarts the derek-dev Discord bot.

6. Run the full test suite:
   ```
   pnpm run test:all
   ```

7. If tests pass: commit and report the branch name and summary. **Do NOT merge to `dev` or `main` yourself** — leave that to the user. When merging to production, copy changed source files to `/root/projects/derek/` and run `pnpm run deploy` there.

8. If tests fail and you cannot fix them:
   - Undo uncommitted changes: `git reset --hard HEAD`
   - Switch back to dev and delete the broken branch
   - The checkpoint from step 1 preserves full context for a fresh attempt

## Self-Modification Rules

You are modifying your own source code whenever you edit files under `source/`, `package.json`, `tsconfig.json`, or `biome.json` in a derek project directory (`/root/projects/derek` or `/root/projects/derek-dev`).

**Always work in the dev worktree, never production.** All self-modification edits must happen in `/root/projects/derek-dev`. If your current cwd is `/root/projects/derek`, use absolute paths (e.g. `/root/projects/derek-dev/source/...`) for all file reads and edits — do not edit files under your own cwd.

### Before any change

1. **Save a checkpoint:**
   Run `/checkpoint save self-mod-<brief-description>` (e.g. `self-mod-add-retry-logic`).

2. **Create a feature branch in the dev worktree** — never modify source on `main` or `dev`:
   ```
   bash: git checkout -b self-mod/YYYY-MM-DD-<description>
   ```
   Switch to it immediately before any edits.

### While changing

3. After each file edit, typecheck to catch errors early:
   ```
   bash: cd /root/projects/derek-dev && pnpm run test:types
   ```
   Fix all type errors before moving on.

4. Commit logical units of work as you go — small commits are easier to roll back.

### After all changes

5. **Build and restart the dev bot:**
   ```
   bash: cd /root/projects/derek-dev && pnpm run deploy
   ```
   This compiles TypeScript and restarts the `derek-dev-discord` service. Safe deploy will auto-rollback if the new version crashes.

6. Run the full test suite:
   ```
   bash: cd /root/projects/derek-dev && pnpm run test:all
   ```

7. If tests pass: commit and report the branch name and summary. **Do NOT merge to `dev` or `main` yourself** — leave that to the user. To promote to production, the user will run:
   ```
   cd /root/projects/derek && git merge <branch> && pnpm run deploy
   ```

8. If tests fail and you cannot fix them:
   - Undo uncommitted changes: `cd /root/projects/derek-dev && git reset --hard HEAD`
   - Switch back to the base branch and delete the broken branch
   - The checkpoint from step 1 preserves full context for a fresh attempt

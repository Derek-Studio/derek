## Self-Modification Rules

When editing files within `/root/projects/derek/source/`, `/root/projects/derek/package.json`,
`/root/projects/derek/tsconfig.json`, or `/root/projects/derek/biome.json` — you are modifying
your own source code. Apply this protocol every time, without exception.

### Before any change

1. **Save a checkpoint** to snapshot the current conversation and files:
   Run the `/checkpoint save self-mod-<brief-description>` command (e.g. `self-mod-add-retry-logic`).

2. **Create a feature branch** — never modify your own source on `main` or `dev`:
   - Use `git_branch` to create `self-mod/YYYY-MM-DD-<description>` (e.g. `self-mod/2026-04-26-add-retry`)
   - Switch to it immediately before any edits

### While changing

3. After each file edit, run the TypeScript typecheck to catch errors early:
   ```
   cd /root/projects/derek && pnpm run test:types
   ```
   Fix all type errors before continuing to the next file.

4. Commit logical units of work on the branch as you go — small commits are easier to roll back.

### After all changes

5. Build and redeploy (compiles TypeScript and restarts the Discord bot):
   ```
   cd /root/projects/derek && npm run deploy
   ```

6. Run the full test suite:
   ```
   cd /root/projects/derek && npm run test:all
   ```

7. If tests pass: commit, then report the branch name and a summary. **Do NOT merge to `dev` or `main` yourself** — leave that decision to the user.

8. If tests fail and you cannot fix them:
   - Undo uncommitted changes: `git reset --hard HEAD`
   - Switch back to dev and delete the broken branch
   - The checkpoint from step 1 preserves full context for a fresh attempt

### What counts as self-modification

You are modifying derek's own source if the file path is under:
- `/root/projects/derek/source/`
- `/root/projects/derek/package.json`
- `/root/projects/derek/tsconfig.json`
- `/root/projects/derek/biome.json`

Changes to any other project (e.g. `/root/projects/my-app/`) are normal edits and do **not** require this protocol.

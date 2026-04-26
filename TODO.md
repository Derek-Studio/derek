# TODO

## Now
- [ ] Add `/bash` Discord slash command — lets operator run shell commands in channel CWD for
  recovery (e.g. `git checkout dev`) without leaving Discord
- [ ] Add `description` field to DiscordSessionData and `/new description:` option + `/describe`
  command to set it — shown in `/status` and injected into session context

## Next
- [ ] Strip `gitState` from CheckpointMetadata and `captureGitState` from saveCheckpoint — overengineered, never read back
- [ ] Create VISION.md + TODO.md for other active projects in ~/projects/

## Later
- [ ] `/rollback` command — `git checkout dev && git branch -D <broken-branch>` for quick
  recovery when a self-modification branch goes wrong
- [ ] Investigate auto-compact at session start when resuming very long sessions

## Done
- [x] Fixed broken symlink — /usr/lib/node_modules/@derek-studio/derek → /root/projects/derek
- [x] Two-pass .env loader — credentials load from ~/.config/derek/.env regardless of CWD
- [x] LLM retry with exponential backoff in headless runtime (4 attempts, 5s/10s/20s)
- [x] derek-discord systemd service — always-on, auto-restarts, reads from global .env
- [x] Self-modification system prompt — branch protocol, typecheck loop, no self-merge rule
- [x] VISION.md + TODO.md autoloaded into system prompt on every turn via appendProjectContext

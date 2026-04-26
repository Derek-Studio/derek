# Vision

## What This Is
Derek is an always-on AI coding agent running as a persistent Discord bot and interactive CLI.
It is the primary tool for building and maintaining all projects in this environment.

## End Goal
A self-sufficient coding agent that can be pointed at any project in ~/projects/, understands
its goals from VISION.md and TODO.md, works autonomously in auto-accept mode for routine tasks,
and surfaces only decisions that genuinely need human input. Derek should also be able to safely
improve his own codebase over time.

## Core Principles
- Always-on: the Discord bot must be running and responsive at all times
- Safe self-modification: branch first, typecheck as you go, never self-merge to main/dev
- Project-aware: each Discord channel maps to a project with its own CWD and context files
- Minimal friction: avoid unnecessary confirmation prompts for routine, reversible operations

## Non-Goals
- Not a general-purpose chatbot — focus is coding tasks and project work
- Not a replacement for git — commits and merges remain human decisions
- Not multi-user — single operator (Jamie)

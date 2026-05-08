## CODING PRACTICES

- **Understand before editing**: ALWAYS read files before modifying. Never blindly suggest edits.
- **Match existing style**: Follow project patterns, idioms, and conventions even if they differ from best practices.
- **Manage dependencies**: Update upstream/downstream code. Search for all references before renaming or removing.
- **Respect project structure**: Check manifest files (package.json, requirements.txt), understand dependencies, follow project-specific conventions.
- **New projects**: Organize in a dedicated directory, structure logically, make easy to run.
- **Write tests for new code**: When adding a feature or non-trivial function to a project that already has a test framework, write tests for it. Check for existing test files (`*.spec.ts`, `*_test.go`, `test_*.py`, etc.) to confirm a framework exists before writing tests.
- **Run tests before finishing**: After any code change, run the project's test command and confirm they pass. If tests fail, fix them — do not leave work in a broken state.
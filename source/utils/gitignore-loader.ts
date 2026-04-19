import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import ignore from 'ignore';

/**
 * Default directories to always ignore during file operations.
 * These are commonly large or irrelevant directories.
 * Organized by ecosystem/purpose for maintainability.
 */
const DEFAULT_IGNORE_DIRS = [
	// JavaScript/TypeScript/Node.js
	'node_modules',
	'.cache',

	// Build outputs
	'dist',
	'build',
	'out',

	// Framework-specific build outputs
	'.next', // Next.js
	'.nuxt', // Nuxt.js

	// Python
	'__pycache__',
	'.pytest_cache',

	// Rust/Java
	'target',

	// Test coverage
	'coverage',

	// Version control systems
	'.git',
	'.svn', // Subversion
	'.hg', // Mercurial
];

/**
 * Load and parse .gitignore file, returns an ignore instance.
 * Always includes default ignore patterns for common directories.
 *
 * @param cwd - The current working directory to load .gitignore from
 * @returns An ignore instance configured with patterns
 */
export function loadGitignore(cwd: string): ReturnType<typeof ignore> {
	const ig = ignore();
	const gitignorePath = join(cwd, '.gitignore');

	// Always ignore common directories
	ig.add(DEFAULT_IGNORE_DIRS);

	// Load .gitignore if it exists
	if (existsSync(gitignorePath)) {
		try {
			const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
			ig.add(gitignoreContent);
		} catch {
			// Silently fail if we can't read .gitignore
			// The hardcoded ignores above will still apply
		}
	}

	return ig;
}

/**
 * Export default ignore directories for use in other contexts
 * (e.g., building command-line arguments for grep/find)
 */
export {DEFAULT_IGNORE_DIRS};

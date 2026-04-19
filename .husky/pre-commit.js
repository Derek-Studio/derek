import {execSync, spawn} from 'child_process';
import fs from 'fs';
import os from 'os';
import {delimiter, join} from 'path';

/**
 * Cross-platform pre-commit hook for husky
 * Handles pnpm availability and lint-staged execution across different operating systems
 */

function getPlatformPaths() {
	const platform = os.platform();

	if (platform === 'win32') {
		// Windows paths
		const homeDir = process.env.USERPROFILE || process.env.HOMEPATH;
		const appData = process.env.APPDATA;
		const localAppData = process.env.LOCALAPPDATA;

		const paths = [];

		// Add common Windows pnpm locations
		if (localAppData) {
			paths.push(join(localAppData, 'pnpm'));
		}
		if (appData) {
			paths.push(join(appData, 'pnpm'));
		}

		// Add common system paths
		paths.push('C:\\Program Files\\nodejs');
		paths.push('C:\\Program Files\\Git\\usr\\bin');

		return paths;
	} else {
		// Unix-like systems (Linux, macOS)
		const homeDir = process.env.HOME || process.env.USERPROFILE;
		const paths = [];

		if (homeDir) {
			// Add common Unix pnpm locations
			paths.push(join(homeDir, '.local', 'share', 'pnpm'));
			paths.push(join(homeDir, '.nvm', 'versions', 'node'));
		}

		// Add common system paths
		paths.push('/usr/local/bin');
		if (os.arch() === 'arm64' && platform === 'darwin') {
			paths.push('/opt/homebrew/bin'); // Apple Silicon Macs
		}
		paths.push('/usr/bin');

		return paths;
	}
}

function detectNodeVersion() {
	try {
		return execSync('node -v', {encoding: 'utf-8', stdio: 'pipe'}).trim();
	} catch (error) {
		console.warn('Could not detect Node.js version, using fallback');
		return null;
	}
}

function setupPath() {
	const platform = os.platform();
	const currentPath = process.env.PATH || process.env.Path || '';
	const additionalPaths = getPlatformPaths();

	// Add Node.js version-specific path if available
	const nodeVersion = detectNodeVersion();
	if (nodeVersion) {
		const homeDir = process.env.HOME || process.env.USERPROFILE;
		if (homeDir) {
			if (platform === 'win32') {
				// On Windows with nvm-windows or similar
				const nvmNodePath = join(
					homeDir,
					'.nvm',
					'versions',
					'node',
					nodeVersion,
					'bin',
				);
				if (
					!additionalPaths.includes(nvmNodePath) &&
					fs.existsSync(nvmNodePath)
				) {
					additionalPaths.unshift(nvmNodePath);
				}
			} else {
				// On Unix-like systems with nvm
				const nvmNodePath = join(
					homeDir,
					'.nvm',
					'versions',
					'node',
					nodeVersion,
					'bin',
				);
				if (
					!additionalPaths.includes(nvmNodePath) &&
					fs.existsSync(nvmNodePath)
				) {
					additionalPaths.unshift(nvmNodePath);
				}
			}
		}
	}

	// Build new PATH - filter out duplicates and non-existent paths
	const uniquePaths = [...new Set(additionalPaths)];
	const validPaths = uniquePaths.filter(path => fs.existsSync(path));
	const newPath = [...validPaths, currentPath.split(delimiter)]
		.flat()
		.join(delimiter);

	// Update process environment
	process.env.PATH = newPath;

	return newPath;
}

function findPnpm() {
	const platform = os.platform();

	try {
		// Try to find pnpm using which/where command
		let command, args;
		if (platform === 'win32') {
			command = 'cmd.exe';
			args = ['/c', 'where', 'pnpm'];
		} else {
			command = 'sh';
			args = ['-c', 'which pnpm'];
		}

		const result = execSync(`${args.join(' ')}`, {
			encoding: 'utf-8',
			stdio: 'pipe',
		});
		const pnpmPaths = result
			.trim()
			.split('\n')
			.filter(path => path && path.trim());
		return pnpmPaths[0] || null;
	} catch (error) {
		// pnpm not found via which/where, try to find it in PATH
		const pathArray = (process.env.PATH || '').split(delimiter);

		for (const pathDir of pathArray) {
			if (!pathDir) continue;

			const pnpmPath = join(
				pathDir,
				platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
			);
			if (fs.existsSync(pnpmPath)) {
				return pnpmPath;
			}
		}

		return null;
	}
}

function runLintStaged() {
	return new Promise((resolve, reject) => {
		const pnpmPath = findPnpm();

		if (!pnpmPath) {
			console.error('Error: pnpm not found in PATH');
			console.error(
				'Please ensure pnpm is installed and available in your PATH',
			);
			reject(new Error('pnpm not found'));
			return;
		}

		console.log(`Using pnpm: ${pnpmPath}`);

		// no-semgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true
		// shell is required for .cmd files on Windows; pnpmPath is controlled by findPnpm()
		const child = spawn(pnpmPath, ['lint-staged'], {
			stdio: 'inherit',
			shell: os.platform() === 'win32', // Use shell on Windows for .cmd files
			env: process.env,
		});

		child.on('error', error => {
			console.error(`Failed to start pnpm lint-staged: ${error.message}`);
			reject(error);
		});

		child.on('close', code => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`pnpm lint-staged exited with code ${code}`));
			}
		});
	});
}

async function main() {
	try {
		console.log('Setting up environment for cross-platform compatibility...');

		// Setup PATH with cross-platform paths
		setupPath();

		console.log('Running lint-staged...');
		await runLintStaged();

		console.log('Pre-commit hook completed successfully!');
		process.exit(0);
	} catch (error) {
		console.error(`Pre-commit hook failed: ${error.message}`);
		process.exit(1);
	}
}

import {dirname} from 'path';
// Check if this module is the main module being run
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Only run if this file is executed directly
if (process.argv[1] === __filename) {
	main();
}

export {
	getPlatformPaths,
	detectNodeVersion,
	setupPath,
	findPnpm,
	runLintStaged,
};

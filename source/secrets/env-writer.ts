import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, isAbsolute, join} from 'node:path';

export type SecretScope = 'global' | 'project';

export interface WriteSecretResult {
	path: string;
	action: 'created' | 'updated';
}

export interface WriteSecretOptions {
	scope: SecretScope;
	projectDir?: string;
}

export function writeSecret(
	key: string,
	value: string,
	opts: WriteSecretOptions,
): WriteSecretResult {
	const envPath =
		opts.scope === 'global'
			? join(homedir(), '.config', 'derek', '.env')
			: join(opts.projectDir ?? process.cwd(), '.env');

	mkdirSync(dirname(envPath), {recursive: true});

	let existing = '';
	try {
		existing = readFileSync(envPath, 'utf8');
	} catch {
		// File doesn't exist yet
	}

	const lines = existing ? existing.split('\n') : [];
	const keyPattern = new RegExp(`^${key}=`);
	const existingIndex = lines.findIndex(l => keyPattern.test(l));
	const escapedValue = value.includes('\n')
		? JSON.stringify(value)
		: value.replace(/"/g, '\\"');
	const newLine = `${key}="${escapedValue}"`;

	let action: WriteSecretResult['action'];
	if (existingIndex >= 0) {
		lines[existingIndex] = newLine;
		action = 'updated';
	} else {
		lines.push(newLine);
		action = 'created';
	}

	const content = lines
		.filter((l, i) => l !== '' || i !== lines.length - 1)
		.join('\n');
	writeFileSync(
		envPath,
		content.endsWith('\n') ? content : content + '\n',
		'utf8',
	);

	return {path: envPath, action};
}

/**
 * Write arbitrary content to a file (e.g. creds.json).
 * Path may be absolute or relative to projectDir.
 */
export function writeSecretFile(
	filePath: string,
	content: string,
	projectDir?: string,
): WriteSecretResult {
	const resolved = isAbsolute(filePath)
		? filePath
		: join(projectDir ?? process.cwd(), filePath);

	const action: WriteSecretResult['action'] = existsSync(resolved)
		? 'updated'
		: 'created';
	mkdirSync(dirname(resolved), {recursive: true});
	writeFileSync(resolved, content, 'utf8');

	return {path: resolved, action};
}

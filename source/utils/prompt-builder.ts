import {existsSync, readFileSync} from 'fs';
import {homedir, platform, release} from 'os';
import {basename, dirname, join, normalize} from 'path';
import {fileURLToPath} from 'url';
import {isSingleToolProfile} from '@/tools/tool-profiles';
import type {TuneConfig} from '@/types/config';
import {TUNE_DEFAULTS} from '@/types/config';
import type {DevelopmentMode} from '@/types/core';
import {getLogger} from '@/utils/logging';
import {getSubagentDescriptions} from '@/utils/prompt-processor';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sectionsDir = join(__dirname, '../../source/app/prompts/sections');

// Cache loaded sections to avoid re-reading files
const sectionCache = new Map<string, string>();

function getSectionFilePath(name: string): string {
	const normalizedName = normalize(name).replace(/^([/\\])+/, '');
	const safeName = basename(normalizedName);
	return join(sectionsDir, `${safeName}.md`);
}

function loadSection(name: string): string {
	const cached = sectionCache.get(name);
	if (cached !== undefined) return cached;

	const filePath = getSectionFilePath(name);
	try {
		const content = readFileSync(filePath, 'utf-8').trim();
		sectionCache.set(name, content);
		return content;
	} catch (error) {
		const logger = getLogger();
		logger.warn(`Failed to load prompt section "${name}": ${String(error)}`);
		sectionCache.set(name, '');
		return '';
	}
}

/** Reset section cache for testing. */
export function resetSectionCache(): void {
	sectionCache.clear();
}

// Cache the last-built system prompt so token-counting callers
// (e.g. /status, /usage, /compact) can access it without needing
// developmentMode/tune/tools as arguments.
let lastBuiltPrompt: string | null = null;

/**
 * Get the last system prompt produced by buildSystemPrompt().
 * Falls back to a minimal prompt if buildSystemPrompt hasn't been called yet.
 */
export function getLastBuiltPrompt(): string {
	return (
		lastBuiltPrompt ?? 'You are Nanocoder, a terminal-based AI coding agent.'
	);
}

/**
 * Update the cached prompt after post-processing (e.g. XML tool injection).
 * Ensures token-counting callers see the full prompt the model receives.
 */
export function setLastBuiltPrompt(prompt: string): void {
	lastBuiltPrompt = prompt;
}

function generateSystemInfo(): string {
	const now = new Date();
	const dateStr = now.toISOString().split('T')[0];

	const getDefaultShell = (): string => {
		if (process.env.SHELL) return process.env.SHELL;
		if (platform() === 'win32') return process.env.COMSPEC || 'cmd.exe';
		if (platform() === 'darwin') return '/bin/zsh';
		return '/bin/bash';
	};

	const getOSName = (): string => {
		switch (platform()) {
			case 'darwin':
				return 'macOS';
			case 'win32':
				return 'Windows';
			case 'linux':
				return 'Linux';
			default:
				return platform();
		}
	};

	return `## SYSTEM INFORMATION

Operating System: ${getOSName()}
OS Version: ${release()}
Platform: ${platform()}
Default Shell: ${getDefaultShell()}
Home Directory: ${homedir()}
Current Working Directory: ${process.cwd()}
Current Date: ${dateStr}`;
}

function appendProjectContext(prompt: string): string {
	const cwd = process.cwd();
	const files: Array<{name: string; heading: string}> = [
		{name: 'AGENTS.md', heading: 'Project Instructions (AGENTS.md)'},
		{name: 'VISION.md', heading: 'Project Vision (VISION.md)'},
		{name: 'TODO.md', heading: 'Current TODO (TODO.md)'},
	];

	let extra = '';
	for (const {name, heading} of files) {
		const filePath = join(cwd, name);
		if (existsSync(filePath)) {
			try {
				const content = readFileSync(filePath, 'utf-8').trim();
				if (content) extra += `\n\n## ${heading}\n\n${content}`;
			} catch {
				// file unreadable — skip silently
			}
		}
	}

	return extra ? `${prompt}${extra}` : prompt;
}

// Search/discovery tools that justify a "prefer native over bash" instruction
// read_file alone doesn't count — the model needs search tools for the advice to be meaningful
const NATIVE_SEARCH_TOOLS = new Set([
	'find_files',
	'search_file_contents',
	'list_directory',
]);

function hasNativeSearchTools(toolSet: Set<string>): boolean {
	for (const tool of NATIVE_SEARCH_TOOLS) {
		if (toolSet.has(tool)) return true;
	}
	return false;
}

function hasAnyGitTool(toolSet: Set<string>): boolean {
	for (const name of toolSet) {
		if (name.startsWith('git_')) return true;
	}
	return false;
}

/**
 * Build a system prompt dynamically based on development mode, tune config, and available tools.
 *
 * Sections are full quality — the prompt gets smaller only because sections for
 * unavailable tools are excluded entirely, not because content is truncated.
 */
export function buildSystemPrompt(
	developmentMode: DevelopmentMode,
	tuneConfig: TuneConfig | undefined,
	availableToolNames: string[],
	toolsDisabled = false,
): string {
	const tune = tuneConfig ?? TUNE_DEFAULTS;
	const singleTool = tune.enabled && isSingleToolProfile(tune.toolProfile);
	const toolSet = new Set(availableToolNames);
	const sections: string[] = [];

	// Always included
	sections.push(loadSection('identity'));
	sections.push(loadSection('core-principles'));

	// Mode-specific task approach
	sections.push(loadSection(`task-approach-${developmentMode}`));

	// Tool rules — XML variant when native tool calling is disabled
	let toolRules = loadSection(toolsDisabled ? 'tool-rules-xml' : 'tool-rules');
	if (singleTool) {
		toolRules +=
			'\n- **IMPORTANT**: Call exactly ONE tool per response. Wait for the result before calling the next tool.';
	}
	sections.push(toolRules);

	// File operations — only if any file mutation tools are available
	if (
		toolSet.has('string_replace') ||
		toolSet.has('write_file') ||
		toolSet.has('delete_file') ||
		toolSet.has('move_file') ||
		toolSet.has('copy_file') ||
		toolSet.has('create_directory')
	) {
		sections.push(loadSection('file-editing'));
	}

	// Native tool preference — only if bash AND search/discovery tools are both available
	if (toolSet.has('execute_bash') && hasNativeSearchTools(toolSet)) {
		sections.push(loadSection('native-tool-preference'));
	}

	// Git tools — only if any git tools are available
	if (hasAnyGitTool(toolSet)) {
		// Plan mode only has read-only git tools — use plan-specific section
		sections.push(
			loadSection(
				developmentMode === 'plan' ? 'git-tools-readonly' : 'git-tools',
			),
		);
		// Self-modification guardrails — the section defines which paths trigger the protocol
		if (developmentMode !== 'plan') {
			sections.push(loadSection('self-modification'));
		}
	}

	// Task management — only if create_task is available AND not in plan mode
	if (toolSet.has('create_task') && developmentMode !== 'plan') {
		sections.push(loadSection('task-management'));
	}

	// Discord tasks — only in the Discord runtime (detected by task_start being
	// registered). Teaches the agent when/how to use background tasks and how
	// to interpret the ACTIVE TASKS auto-inject block.
	if (toolSet.has('task_start') || toolSet.has('task_checklist')) {
		sections.push(loadSection('discord-tasks'));
	}

	// Web tools — only if web_search or fetch_url are available
	if (toolSet.has('web_search') || toolSet.has('fetch_url')) {
		sections.push(loadSection('web-tools'));
	}

	// Diagnostics — only if lsp_get_diagnostics is available
	if (toolSet.has('lsp_get_diagnostics')) {
		// Plan mode: check for existing issues, not "fix what you introduce"
		sections.push(
			loadSection(
				developmentMode === 'plan' ? 'diagnostics-readonly' : 'diagnostics',
			),
		);
	}

	// Asking questions — only if ask_user is available
	if (toolSet.has('ask_user')) {
		sections.push(loadSection('asking-questions'));
	}

	// Coding practices and constraints — not needed in plan mode
	// (plan task approach already covers the relevant guidance)
	if (developmentMode !== 'plan') {
		sections.push(loadSection('coding-practices'));
		sections.push(loadSection('constraints'));
	}

	// Subagents — only if the agent tool is available
	if (toolSet.has('agent')) {
		const subagentSection = loadSection('subagents');
		const subagentInfo = `${subagentSection}

### Available subagents:

${getSubagentDescriptions()}`;
		sections.push(subagentInfo);
	}

	// System info (dynamic)
	sections.push(generateSystemInfo());

	// Compose and append AGENTS.md
	let prompt = sections.filter(Boolean).join('\n\n');
	prompt = appendProjectContext(prompt);

	// Cache for token-counting callers that don't have access to the inputs
	lastBuiltPrompt = prompt;

	return prompt;
}

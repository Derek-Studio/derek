import path from 'node:path';
import type {Attachment, Message as DiscordJsMessage} from 'discord.js';
import type {MessageImagePart} from '@/types/core';

/**
 * Maximum size of a single text attachment we'll inline (bytes).
 * Anything larger gets a stub note instead — the user can ask the agent
 * to read it from disk if it's already in the working directory.
 */
const MAX_TEXT_FILE_BYTES = 256 * 1024; // 256 KB

/**
 * Hard cap on combined text content inlined from all attachments in a single
 * message. Prevents one message from torching the context window.
 */
const MAX_TOTAL_TEXT_BYTES = 512 * 1024; // 512 KB

/**
 * File extensions we treat as text even when Discord doesn't send a
 * `text/*` contentType. Discord often serves `application/octet-stream`
 * for source files.
 */
const TEXT_EXTENSIONS = new Set([
	'.txt',
	'.md',
	'.markdown',
	'.log',
	'.json',
	'.jsonc',
	'.json5',
	'.yaml',
	'.yml',
	'.toml',
	'.ini',
	'.cfg',
	'.conf',
	'.env',
	'.csv',
	'.tsv',
	'.xml',
	'.html',
	'.htm',
	'.css',
	'.scss',
	'.sass',
	'.less',
	'.js',
	'.mjs',
	'.cjs',
	'.jsx',
	'.ts',
	'.tsx',
	'.mts',
	'.cts',
	'.py',
	'.rb',
	'.go',
	'.rs',
	'.java',
	'.kt',
	'.kts',
	'.swift',
	'.c',
	'.h',
	'.cc',
	'.cpp',
	'.hpp',
	'.cs',
	'.php',
	'.pl',
	'.lua',
	'.r',
	'.sh',
	'.bash',
	'.zsh',
	'.fish',
	'.ps1',
	'.bat',
	'.cmd',
	'.dockerfile',
	'.sql',
	'.graphql',
	'.gql',
	'.proto',
	'.tf',
	'.hcl',
	'.nix',
	'.gitignore',
	'.gitattributes',
	'.editorconfig',
	'.diff',
	'.patch',
	'.svg', // SVG is text — markup users may reasonably want inlined
]);

/**
 * Map common file extensions to a markdown code-block language hint.
 * Only used for syntax highlighting in the inlined block.
 */
const LANG_BY_EXT: Record<string, string> = {
	'.md': 'markdown',
	'.markdown': 'markdown',
	'.json': 'json',
	'.jsonc': 'json',
	'.json5': 'json5',
	'.yaml': 'yaml',
	'.yml': 'yaml',
	'.toml': 'toml',
	'.xml': 'xml',
	'.html': 'html',
	'.htm': 'html',
	'.css': 'css',
	'.scss': 'scss',
	'.sass': 'sass',
	'.less': 'less',
	'.js': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	'.jsx': 'jsx',
	'.ts': 'typescript',
	'.tsx': 'tsx',
	'.mts': 'typescript',
	'.cts': 'typescript',
	'.py': 'python',
	'.rb': 'ruby',
	'.go': 'go',
	'.rs': 'rust',
	'.java': 'java',
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	'.swift': 'swift',
	'.c': 'c',
	'.h': 'c',
	'.cc': 'cpp',
	'.cpp': 'cpp',
	'.hpp': 'cpp',
	'.cs': 'csharp',
	'.php': 'php',
	'.pl': 'perl',
	'.lua': 'lua',
	'.r': 'r',
	'.sh': 'bash',
	'.bash': 'bash',
	'.zsh': 'bash',
	'.fish': 'fish',
	'.ps1': 'powershell',
	'.sql': 'sql',
	'.graphql': 'graphql',
	'.gql': 'graphql',
	'.proto': 'protobuf',
	'.tf': 'hcl',
	'.hcl': 'hcl',
	'.nix': 'nix',
	'.diff': 'diff',
	'.patch': 'diff',
	'.svg': 'xml',
};

export interface ProcessedAttachments {
	/** Image attachments, passed by URL — the LLM provider fetches them. */
	imageParts: MessageImagePart[];
	/** Markdown blocks (one per text file) to append to the user message. */
	textBlocks: string[];
	/** Human-readable notes for skipped/oversized/binary attachments. */
	notes: string[];
}

function isImageAttachment(att: Attachment): boolean {
	return Boolean(att.contentType?.startsWith('image/'));
}

function isTextAttachment(att: Attachment): boolean {
	if (att.contentType?.startsWith('text/')) return true;
	if (att.contentType === 'application/json') return true;
	if (att.contentType === 'application/xml') return true;
	const ext = path.extname(att.name ?? '').toLowerCase();
	return ext !== '' && TEXT_EXTENSIONS.has(ext);
}

function langForFilename(name: string): string {
	const ext = path.extname(name).toLowerCase();
	return LANG_BY_EXT[ext] ?? '';
}

/**
 * Choose a fence string that won't collide with backticks inside the file.
 * Walks up from ``` until one isn't a substring of the content.
 */
function pickFence(content: string): string {
	let fence = '```';
	while (content.includes(fence)) fence += '`';
	return fence;
}

/**
 * Inspect a Discord message's attachments and produce LLM-ready inputs:
 *   - Images become `MessageImagePart[]` (URLs forwarded directly)
 *   - Text files are fetched and inlined as fenced code blocks
 *   - Anything else generates a skip note
 */
export async function processAttachments(
	message: DiscordJsMessage,
): Promise<ProcessedAttachments> {
	const out: ProcessedAttachments = {
		imageParts: [],
		textBlocks: [],
		notes: [],
	};

	if (message.attachments.size === 0) return out;

	let totalTextBytes = 0;

	for (const att of message.attachments.values()) {
		if (isImageAttachment(att)) {
			out.imageParts.push({
				type: 'image',
				url: att.url,
				...(att.contentType ? {mimeType: att.contentType} : {}),
			});
			continue;
		}

		if (isTextAttachment(att)) {
			if (att.size > MAX_TEXT_FILE_BYTES) {
				out.notes.push(
					`(skipped \`${att.name}\` — ${formatBytes(att.size)}, exceeds ${formatBytes(MAX_TEXT_FILE_BYTES)} per-file limit)`,
				);
				continue;
			}
			if (totalTextBytes + att.size > MAX_TOTAL_TEXT_BYTES) {
				out.notes.push(
					`(skipped \`${att.name}\` — would exceed ${formatBytes(MAX_TOTAL_TEXT_BYTES)} total text limit)`,
				);
				continue;
			}

			try {
				const res = await fetch(att.url);
				if (!res.ok) {
					out.notes.push(
						`(failed to fetch \`${att.name}\`: HTTP ${res.status})`,
					);
					continue;
				}
				const text = await res.text();
				totalTextBytes += Buffer.byteLength(text, 'utf8');
				const lang = langForFilename(att.name ?? '');
				const fence = pickFence(text);
				out.textBlocks.push(
					`📎 **${att.name}**\n${fence}${lang}\n${text}\n${fence}`,
				);
			} catch (err) {
				out.notes.push(
					`(failed to fetch \`${att.name}\`: ${err instanceof Error ? err.message : String(err)})`,
				);
			}
			continue;
		}

		// Unknown / binary attachment — record a note so the agent at least
		// knows it was sent.
		out.notes.push(
			`(attachment \`${att.name}\` — ${att.contentType ?? 'unknown type'}, ${formatBytes(att.size)} — not inlined)`,
		);
	}

	return out;
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

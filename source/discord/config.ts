import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import type {DiscordConfig} from './types.js';

function parseCommaSeparated(value: string | undefined): string[] {
	if (!value || value.trim() === '') return [];
	return value
		.split(',')
		.map(s => s.trim())
		.filter(Boolean);
}

/**
 * Parse explicit channel→directory mapping from env.
 * Format: "channelId1:/path/to/dir1,channelId2:/path/to/dir2"
 */
function parseChannelProjectMapping(
	value: string | undefined,
): Record<string, string> {
	if (!value || value.trim() === '') return {};
	const mapping: Record<string, string> = {};
	for (const entry of value.split(',')) {
		const colonIdx = entry.indexOf(':');
		if (colonIdx === -1) continue;
		const channelId = entry.slice(0, colonIdx).trim();
		const dir = entry.slice(colonIdx + 1).trim();
		if (channelId && dir) {
			mapping[channelId] = dir;
		}
	}
	return mapping;
}

interface ChannelEntry {
	id: string;
	bot: string;
	cwd: string;
}

/**
 * Load channel→cwd mappings from the shared channels.json config.
 * Each bot reads the file and filters to entries matching its own identity.
 * File location: ~/.config/derek/channels.json
 */
function loadChannelsConfig(botIdentity: string): {
	allowedChannelIds: string[];
	channelProjectMapping: Record<string, string>;
} {
	const configPath = join(homedir(), '.config', 'derek', 'channels.json');
	if (!existsSync(configPath)) {
		return {allowedChannelIds: [], channelProjectMapping: {}};
	}

	try {
		const entries: ChannelEntry[] = JSON.parse(
			readFileSync(configPath, 'utf8'),
		);
		const mine = entries.filter(e => e.bot === botIdentity);
		return {
			allowedChannelIds: mine.map(e => e.id),
			channelProjectMapping: Object.fromEntries(mine.map(e => [e.id, e.cwd])),
		};
	} catch {
		return {allowedChannelIds: [], channelProjectMapping: {}};
	}
}

export function loadDiscordConfig(): DiscordConfig {
	const botToken = process.env.DISCORD_BOT_TOKEN;
	if (!botToken) {
		throw new Error('DISCORD_BOT_TOKEN is required. Set it in your .env file.');
	}

	const applicationId = process.env.DISCORD_APPLICATION_ID;
	if (!applicationId) {
		throw new Error(
			'DISCORD_APPLICATION_ID is required. Set it in your .env file.',
		);
	}

	const botIdentity = process.env.BOT_IDENTITY ?? 'derek';
	const channelConfig = loadChannelsConfig(botIdentity);

	// channels.json entries are additive with env-var config; channels.json wins on cwd conflicts
	const envAllowedChannels = parseCommaSeparated(
		process.env.DISCORD_ALLOWED_CHANNEL_IDS,
	);
	const allAllowedChannels = [
		...new Set([...envAllowedChannels, ...channelConfig.allowedChannelIds]),
	];

	return {
		botToken,
		applicationId,
		guildIds: parseCommaSeparated(process.env.DISCORD_GUILD_IDS),
		allowedChannelIds: allAllowedChannels,
		workingDirectory: process.env.DISCORD_WORKING_DIRECTORY || process.cwd(),
		projectsDirectory: process.env.DISCORD_PROJECTS_DIRECTORY || '',
		channelProjectMapping: {
			...parseChannelProjectMapping(process.env.DISCORD_CHANNEL_PROJECTS),
			...channelConfig.channelProjectMapping,
		},
	};
}

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

	return {
		botToken,
		applicationId,
		guildIds: parseCommaSeparated(process.env.DISCORD_GUILD_IDS),
		allowedChannelIds: parseCommaSeparated(
			process.env.DISCORD_ALLOWED_CHANNEL_IDS,
		),
		workingDirectory: process.env.DISCORD_WORKING_DIRECTORY || process.cwd(),
		projectsDirectory: process.env.DISCORD_PROJECTS_DIRECTORY || '',
		channelProjectMapping: parseChannelProjectMapping(
			process.env.DISCORD_CHANNEL_PROJECTS,
		),
	};
}

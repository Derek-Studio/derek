import {getChannelContext} from '@/secrets/active-context';
import {
	dispatchShareRequest,
	hasShareDispatchHandler,
} from '@/secrets/share-dispatcher';
import type {NanocoderToolExport} from '@/types/core';
import {jsonSchema, tool} from '@/types/core';

interface ShareEnvVarArgs {
	key: string;
	ttl_minutes?: number;
}

const shareEnvVarCoreTool = tool({
	description:
		'Share an environment variable value with the operator via a one-time secure link. ' +
		'Posts the link in the Discord channel — the operator opens it in their browser and ' +
		'sees the value there. The value is never sent through Discord or the LLM context.\n\n' +
		'Use this when the operator needs to retrieve a credential or token that is already ' +
		'set in the server environment (e.g. to copy it elsewhere). ' +
		'The link is single-use and expires after the TTL.',
	inputSchema: jsonSchema<ShareEnvVarArgs>({
		type: 'object',
		properties: {
			key: {
				type: 'string',
				description:
					'The environment variable name to share (e.g. GITHUB_TOKEN). ' +
					'Must be set in the current process environment.',
			},
			ttl_minutes: {
				type: 'number',
				description:
					'How many minutes the link stays valid (default 5, max 30).',
			},
		},
		required: ['key'],
	}),
	needsApproval: false,
	execute: async (args: ShareEnvVarArgs): Promise<string> => {
		if (!hasShareDispatchHandler()) {
			return (
				'The share_env_var tool is only available in the Discord runtime. ' +
				'Run `echo $' +
				args.key +
				'` in a terminal to retrieve the value directly.'
			);
		}

		const ctx = getChannelContext();
		if (!ctx) {
			return (
				'Could not determine the current channel context. ' +
				'This tool requires the Discord runtime with an active channel.'
			);
		}

		const value = process.env[args.key];
		if (value === undefined) {
			return `❌ \`${args.key}\` is not set in the current environment.`;
		}

		const ttlMs =
			typeof args.ttl_minutes === 'number'
				? Math.min(Math.max(args.ttl_minutes, 0.5), 30) * 60 * 1000
				: undefined;

		const result = await dispatchShareRequest({
			key: args.key,
			value,
			channelId: ctx.channelId,
			ttlMs,
			signal: ctx.signal,
		});

		const expiresMin = Math.round((ttlMs ?? 5 * 60 * 1000) / 60_000);

		switch (result.status) {
			case 'posted':
				return (
					`✅ Share link for \`${args.key}\` posted in channel. ` +
					`Single-use, expires in ${expiresMin} min.`
				);
			case 'error':
				return `❌ Failed to post share link for \`${args.key}\`: ${result.reason}`;
		}
	},
});

export const shareEnvVarTool: NanocoderToolExport = {
	name: 'share_env_var',
	tool: shareEnvVarCoreTool,
	readOnly: true,
};

import {getChannelContext} from '@/secrets/active-context';
import {
	dispatchSecretRequest,
	hasSecretDispatchHandler,
} from '@/secrets/dispatcher';
import type {SecretScope} from '@/secrets/env-writer';
import type {NanocoderToolExport} from '@/types/core';
import {jsonSchema, tool} from '@/types/core';

interface RequestSecretArgs {
	key: string;
	description: string;
	scope: SecretScope;
	file_path?: string;
	ttl_minutes?: number;
}

const requestSecretCoreTool = tool({
	description:
		'Ask the operator to supply a secret value (API key, password, token, credentials file, etc.) ' +
		'that Derek needs but should not receive directly. Posts a one-time secure link ' +
		'in the channel — the operator opens it in their browser and pastes the value ' +
		'there. The value is written directly to the server and never passes through ' +
		'Discord or the LLM context.\n\n' +
		'Two modes:\n' +
		'• **Env var** (default): omit file_path — value is written as KEY="value" in the .env file. ' +
		'Use scope "global" for secrets shared across all projects, "project" for the current directory.\n' +
		'• **File** (e.g. creds.json, service-account.json): set file_path to the destination path ' +
		'(relative to working directory or absolute) — the full file contents are written verbatim.',
	inputSchema: jsonSchema<RequestSecretArgs>({
		type: 'object',
		properties: {
			key: {
				type: 'string',
				description:
					'Identifier for this secret. For env vars: uppercase with underscores (e.g. GITHUB_TOKEN). ' +
					'For files: a short descriptive name (e.g. gcp-service-account).',
			},
			description: {
				type: 'string',
				description:
					'One sentence explaining what this secret is for and why Derek needs it.',
			},
			scope: {
				type: 'string',
				enum: ['global', 'project'],
				description:
					'For env vars: "global" writes to ~/.config/derek/.env, "project" writes to <workingDirectory>/.env. ' +
					'For file mode (file_path set): ignored — the file is always written to the resolved path.',
			},
			file_path: {
				type: 'string',
				description:
					'If set, write the submitted content to this file path instead of an env var. ' +
					'Relative paths are resolved from the working directory. ' +
					'Example: "creds.json", "config/service-account.json", "/etc/myapp/creds.json".',
			},
			ttl_minutes: {
				type: 'number',
				description:
					'How many minutes the link stays valid (default 5, max 30).',
			},
		},
		required: ['key', 'description', 'scope'],
	}),
	needsApproval: false,
	execute: async (args: RequestSecretArgs): Promise<string> => {
		if (!hasSecretDispatchHandler()) {
			return (
				'The request_secret tool is only available in the Discord runtime. ' +
				'Please set the secret manually in the relevant .env file and try again.'
			);
		}

		const ctx = getChannelContext();
		if (!ctx) {
			return (
				'Could not determine the current channel context. ' +
				'This tool requires the Discord runtime with an active channel.'
			);
		}

		const ttlMs =
			typeof args.ttl_minutes === 'number'
				? Math.min(Math.max(args.ttl_minutes, 0.5), 30) * 60 * 1000
				: undefined;

		const result = await dispatchSecretRequest({
			key: args.key,
			description: args.description,
			scope: args.scope,
			projectDir: ctx.workingDirectory,
			filePath: args.file_path,
			ttlMs,
			channelId: ctx.channelId,
			signal: ctx.signal,
		});

		const label = args.file_path
			? `file \`${args.file_path}\``
			: `\`${args.key}\``;

		switch (result.status) {
			case 'stored':
				return (
					`✅ Secret ${label} stored at \`${result.path}\` (${result.action}). ` +
					`Ready to use — restart any process that needs to pick it up.`
				);
			case 'expired':
				return (
					`⌛ The secret request for ${label} expired before the operator submitted it. ` +
					`Call request_secret again to generate a new link.`
				);
			case 'cancelled':
				return `🚫 Secret request for ${label} was cancelled${result.reason ? `: ${result.reason}` : ''}.`;
			case 'denied':
				return `❌ Secret request for ${label} was denied: ${result.reason}`;
			case 'error':
				return `❌ Error requesting secret ${label}: ${result.reason}`;
		}
	},
});

export const requestSecretTool: NanocoderToolExport = {
	name: 'request_secret',
	tool: requestSecretCoreTool,
	readOnly: false,
};

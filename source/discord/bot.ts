import {Client, GatewayIntentBits, Partials} from 'discord.js';
import {
	type SecretDispatchRequest,
	setSecretDispatchHandler,
} from '@/secrets/dispatcher';
import {createSecretLink} from '@/secrets/http-server';
import {pendingSecretStore} from '@/secrets/pending-store';
import {registerCommands} from './commands/registry.js';
import {loadDiscordConfig} from './config.js';
import {setupGatewayHandlers} from './gateway.js';
import {HeadlessRuntime} from './runtime/headless-runtime.js';
import {discordSessionStore} from './session/discord-session.js';
import {messageStore} from './session/message-store.js';

/**
 * Start the Derek Discord bot.
 *
 * This is the main entry point called from `derek discord`.
 * It initializes the headless runtime (LLM + tools), connects to Discord,
 * registers slash commands, and starts handling messages.
 */
export async function startDiscordBot(opts?: {
	provider?: string;
	model?: string;
}): Promise<void> {
	console.log('Derek Discord Bot starting...');

	// Load config from env
	const config = loadDiscordConfig();
	console.log(`  Application ID: ${config.applicationId}`);
	console.log(
		`  Guild IDs: ${config.guildIds.length > 0 ? config.guildIds.join(', ') : '(all)'}`,
	);
	console.log(`  Working directory: ${config.workingDirectory}`);
	if (config.projectsDirectory) {
		console.log(`  Projects directory: ${config.projectsDirectory}`);
	}
	if (Object.keys(config.channelProjectMapping).length > 0) {
		console.log(
			`  Channel mappings: ${Object.keys(config.channelProjectMapping).length} explicit`,
		);
	}

	// Initialize stores
	console.log('Initializing session store...');
	await discordSessionStore.initialize();
	await messageStore.initialize();

	// Initialize the headless runtime (LLM client + tool manager)
	console.log('Initializing AI runtime...');
	const runtime = new HeadlessRuntime();
	await runtime.initialize(opts?.provider, opts?.model);
	console.log(`  Provider: ${runtime.getProvider()}`);
	console.log(`  Model: ${runtime.getModel()}`);

	// Register slash commands with Discord
	console.log('Registering slash commands...');
	await registerCommands(config);

	// Create Discord.js client
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.DirectMessages,
		],
		partials: [Partials.Channel], // Required for DMs
	});

	// Register the HTTP one-time-link secret handler
	setSecretDispatchHandler(async (request: SecretDispatchRequest) => {
		const entry = pendingSecretStore.create({
			key: request.key,
			description: request.description,
			scope: request.scope,
			projectDir: request.projectDir,
			filePath: request.filePath,
			channelId: request.channelId,
			ttlMs: request.ttlMs ?? 5 * 60 * 1000,
			resolve: () => {},
		});

		return new Promise(resolve => {
			// Patch the resolve onto the entry after creation
			(entry as {resolve: typeof resolve}).resolve = resolve;

			if (request.signal?.aborted) {
				pendingSecretStore.cancel(entry.id, 'Aborted before posting');
				return;
			}
			request.signal?.addEventListener(
				'abort',
				() => pendingSecretStore.cancel(entry.id, 'Agent turn was stopped'),
				{once: true},
			);

			void (async () => {
				try {
					const url = await createSecretLink(request, entry.id);
					const channel = await client.channels
						.fetch(request.channelId)
						.catch(() => null);
					if (channel && 'send' in channel) {
						const expiresMin = Math.round(
							(entry.expiresAt - Date.now()) / 60_000,
						);
						const label = request.filePath
							? `file \`${request.filePath}\``
							: `\`${request.key}\``;
						await (channel as import('discord.js').TextChannel).send(
							`🔐 **Derek needs a secret: ${label}**\n` +
								`${request.description}\n\n` +
								`**[Click here to provide it securely](${url})**\n` +
								`*(link expires in ${expiresMin} min — the value goes directly to the server, not through Discord)*`,
						);
					}
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					pendingSecretStore.cancel(entry.id, `Failed to post link: ${reason}`);
				}
			})();
		});
	});

	// Setup event handlers
	setupGatewayHandlers(client, config, runtime);

	client.once('clientReady', () => {
		console.log(`\nDerek Discord Bot is online as ${client.user?.tag}`);
		console.log(`  Serving ${client.guilds.cache.size} guild(s)`);
		console.log('  Ready for messages.\n');
	});

	// Handle shutdown
	const shutdown = async () => {
		console.log('\nShutting down...');
		client.destroy();
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	// Login
	await client.login(config.botToken);
}

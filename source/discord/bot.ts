import {Client, GatewayIntentBits, Partials} from 'discord.js';
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

	// Setup event handlers
	setupGatewayHandlers(client, config, runtime);

	client.once('ready', () => {
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

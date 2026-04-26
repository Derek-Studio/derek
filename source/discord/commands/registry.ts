import {
	REST,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
	Routes,
	SlashCommandBuilder,
} from 'discord.js';
import type {DiscordConfig} from '../types.js';

export function getCommandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
	return [
		new SlashCommandBuilder()
			.setName('new')
			.setDescription('Start a fresh session in this channel')
			.addStringOption(opt =>
				opt
					.setName('cwd')
					.setDescription('Working directory for this session')
					.setRequired(false),
			)
			.addStringOption(opt =>
				opt.setName('model').setDescription('Model to use').setRequired(false),
			)
			.addStringOption(opt =>
				opt
					.setName('provider')
					.setDescription('Provider to use')
					.setRequired(false),
			)
			.toJSON(),

		new SlashCommandBuilder()
			.setName('fork')
			.setDescription('Fork the current session into a new thread')
			.addStringOption(opt =>
				opt.setName('name').setDescription('Thread name').setRequired(false),
			)
			.toJSON(),

		new SlashCommandBuilder()
			.setName('status')
			.setDescription('Show current session info')
			.toJSON(),

		new SlashCommandBuilder()
			.setName('model')
			.setDescription('Switch the model for this session')
			.addStringOption(opt =>
				opt.setName('name').setDescription('Model name/ID').setRequired(true),
			)
			.toJSON(),

		new SlashCommandBuilder()
			.setName('provider')
			.setDescription('Switch the provider for this session')
			.addStringOption(opt =>
				opt.setName('name').setDescription('Provider name').setRequired(true),
			)
			.toJSON(),

		new SlashCommandBuilder()
			.setName('clear')
			.setDescription('Clear conversation history in this session')
			.toJSON(),

		new SlashCommandBuilder()
			.setName('compact')
			.setDescription('Compress conversation context')
			.toJSON(),

		new SlashCommandBuilder()
			.setName('mode')
			.setDescription('Set tool approval mode')
			.addStringOption(opt =>
				opt
					.setName('mode')
					.setDescription('Development mode')
					.setRequired(true)
					.addChoices(
						{name: 'normal', value: 'normal'},
						{name: 'auto-accept', value: 'auto-accept'},
						{name: 'yolo', value: 'yolo'},
					),
			)
			.toJSON(),

		new SlashCommandBuilder()
			.setName('sessions')
			.setDescription('List recent sessions')
			.toJSON(),

		new SlashCommandBuilder()
			.setName('restart')
			.setDescription('Restart the bot process')
			.toJSON(),

		new SlashCommandBuilder()
			.setName('stop')
			.setDescription(
				'Interrupt the in-progress response in this channel so you can give new feedback',
			)
			.toJSON(),

		new SlashCommandBuilder()
			.setName('bash')
			.setDescription("Run a shell command in this channel's working directory")
			.addStringOption(opt =>
				opt
					.setName('command')
					.setDescription('Shell command to run (e.g. git status)')
					.setRequired(true),
			)
			.toJSON(),

		new SlashCommandBuilder()
			.setName('task')
			.setDescription('Run a task in the background while you keep chatting')
			.addStringOption(opt =>
				opt
					.setName('prompt')
					.setDescription('What should Derek work on?')
					.setRequired(true),
			)
			.toJSON(),

		new SlashCommandBuilder()
			.setName('project')
			.setDescription('Manage projects')
			.addSubcommand(sub =>
				sub
					.setName('create')
					.setDescription('Create a new project and link this channel to it')
					.addStringOption(opt =>
						opt
							.setName('name')
							.setDescription('Project name (e.g. my-app)')
							.setRequired(true),
					)
					.addStringOption(opt =>
						opt
							.setName('description')
							.setDescription('One-line description for VISION.md')
							.setRequired(false),
					),
			)
			.toJSON(),
	];
}

export async function registerCommands(config: DiscordConfig): Promise<void> {
	const rest = new REST({version: '10'}).setToken(config.botToken);
	const commands = getCommandDefinitions();

	console.log(`Registering ${commands.length} slash commands...`);

	if (config.guildIds.length > 0) {
		// Register as guild commands (instant, good for development)
		for (const guildId of config.guildIds) {
			await rest.put(
				Routes.applicationGuildCommands(config.applicationId, guildId),
				{body: commands},
			);
			console.log(`  Registered commands for guild ${guildId}`);
		}
	} else {
		// Register as global commands (can take up to 1 hour to propagate)
		await rest.put(Routes.applicationCommands(config.applicationId), {
			body: commands,
		});
		console.log('  Registered global commands');
	}
}

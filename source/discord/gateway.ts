import fs from 'node:fs';
import path from 'node:path';
import {
	ChannelType,
	type ChatInputCommandInteraction,
	type Client,
	type Message as DiscordJsMessage,
	type TextChannel,
	type ThreadChannel,
} from 'discord.js';
import type {MessageImagePart} from '@/types/core';
import {type ProcessedAttachments, processAttachments} from './attachments.js';
import type {HeadlessRuntime} from './runtime/headless-runtime.js';
import {requestToolApproval} from './runtime/tool-approval.js';
import {
	autoCompact,
	estimateTokens,
	guardMessageSize,
} from './session/compaction.js';
import {
	DiscordSessionStore,
	discordSessionStore,
} from './session/discord-session.js';
import {messageStore} from './session/message-store.js';
import {buildActiveTasksBlock} from './tasks/active-tasks-block.js';
import {withTaskInvocationContext} from './tasks/task-invocation-context.js';
import {bindTaskRuntime, interruptTask} from './tasks/task-runner.js';
import {taskStore} from './tasks/task-store.js';
import {allTaskTools} from './tasks/task-tools.js';
import type {DiscordConfig, DiscordDevelopmentMode} from './types.js';
import {formatSessionStatus} from './ui/message-formatter.js';
import {splitMessage} from './ui/message-splitter.js';
import {StatusLine} from './ui/status-line.js';

/**
 * Tools the main-channel agent should NOT see.
 *
 * - `task_checklist` is only meaningful inside a task's own runtime.
 * - `create_task` / `update_task` / `list_tasks` / `delete_task` are a
 *   per-cwd todo-list the CLI uses as scratch memory. In the Discord
 *   runtime they serve no purpose and collide semantically with the
 *   real Task system (`task_start` etc.), so we hide them. If an agent
 *   wants persistent per-project notes it should use TODO.md.
 */
const MAIN_CHANNEL_EXCLUDED_TOOLS = [
	'task_checklist',
	'create_task',
	'update_task',
	'list_tasks',
	'delete_task',
];

// ─── Per-Channel State Machine ─────────────────────────────────────────────
//
// Each channel carrying a conversation has a single ChannelRunState that
// tracks whether Derek is currently running a main-channel turn and what
// messages arrived while he was busy. Parallel work is handled by *tasks*
// (see ./tasks/), which run in their own Discord threads and do not block
// the main channel. The per-channel queue here only serialises main-channel
// turns.

/** One queued user message, fully resolved (attachments already processed). */
interface QueuedMessage {
	discordMessage: DiscordJsMessage;
	content: string;
	authorUsername: string;
	attachments: ProcessedAttachments;
	receivedAt: number;
}

interface ActiveRun {
	controller: AbortController;
	consumedIds: string[];
	startedAt: number;
	userContent: string;
	imageParts: MessageImagePart[];
	triggerMessage: DiscordJsMessage;
}

interface ChannelRunState {
	active: ActiveRun | null;
	queued: QueuedMessage[];
	/** Timestamp when the previous turn started; used to surface tasks that
	 * completed since then in the auto-injected ACTIVE TASKS block. */
	lastTurnStartedAt: number;
}

const channelStates = new Map<string, ChannelRunState>();

function getChannelState(channelId: string): ChannelRunState {
	let state = channelStates.get(channelId);
	if (!state) {
		state = {active: null, queued: [], lastTurnStartedAt: 0};
		channelStates.set(channelId, state);
	}
	return state;
}

/**
 * Resolve the working directory for a new session in a channel.
 * Checks channelProjectMapping first, then falls back to config.workingDirectory.
 * For existing sessions, session.workingDirectory takes priority — see processUserMessage.
 */
function defaultWorkingDirectory(
	config: DiscordConfig,
	channelId: string,
): string {
	return config.channelProjectMapping[channelId] ?? config.workingDirectory;
}

const MISSED_MESSAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * On startup, fetch messages that arrived in active channels while the bot
 * was offline and process them in order.
 */
async function replayMissedMessages(
	client: Client,
	config: DiscordConfig,
	runtime: HeadlessRuntime,
): Promise<void> {
	const sessions = discordSessionStore.listSessions();

	for (const session of sessions) {
		if (!session.lastProcessedMessageId) continue;

		try {
			const channel = await client.channels.fetch(session.channelId);
			if (!channel || !channel.isTextBased()) continue;

			const fetched = await (
				channel as TextChannel | ThreadChannel
			).messages.fetch({
				limit: 20,
				after: session.lastProcessedMessageId,
			});

			const cutoff = Date.now() - MISSED_MESSAGE_MAX_AGE_MS;
			const missed = [...fetched.values()]
				.filter(m => !m.author.bot && m.createdTimestamp > cutoff)
				.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

			if (missed.length === 0) continue;

			console.log(
				`Replaying ${missed.length} missed message(s) for channel ${session.channelId}`,
			);

			for (const msg of missed) {
				await handleMessage(client, config, runtime, msg);
			}
		} catch (err) {
			console.warn(
				`Could not replay messages for channel ${session.channelId}:`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}
}

export function setupGatewayHandlers(
	client: Client,
	config: DiscordConfig,
	runtime: HeadlessRuntime,
): void {
	// Initialise task persistence + register task tools + bind runtime
	// references for the task tools to use.
	void taskStore.initialize().catch(err => {
		console.error('Failed to initialise task store:', err);
	});
	runtime.registerToolExports(allTaskTools);
	bindTaskRuntime(client, runtime);

	client.on('messageCreate', async (message: DiscordJsMessage) => {
		try {
			await handleMessage(client, config, runtime, message);
		} catch (error) {
			console.error('Error handling message:', error);
		}
	});

	client.on('interactionCreate', async interaction => {
		try {
			if (interaction.isChatInputCommand()) {
				await handleSlashCommand(
					client,
					config,
					runtime,
					interaction as ChatInputCommandInteraction,
				);
				return;
			}
			// Tool-approval buttons are awaited via awaitMessageComponent inside
			// requestToolApproval; they don't route through here.
		} catch (error) {
			console.error('Error handling interaction:', error);
			if (interaction.isRepliable() && !interaction.replied) {
				await interaction
					.reply({content: '❌ An error occurred.', ephemeral: true})
					.catch(() => {});
			}
		}
	});

	client.once('clientReady', () => {
		replayMissedMessages(client, config, runtime).catch(err => {
			console.error('Error replaying missed messages:', err);
		});
	});
}

// ─── Message Ingestion ────────────────────────────────────────────────────

async function handleMessage(
	client: Client,
	config: DiscordConfig,
	runtime: HeadlessRuntime,
	message: DiscordJsMessage,
): Promise<void> {
	if (message.author.bot) return;

	if (
		message.guild &&
		config.guildIds.length > 0 &&
		!config.guildIds.includes(message.guild.id)
	) {
		return;
	}

	if (
		config.allowedChannelIds.length > 0 &&
		!config.allowedChannelIds.includes(message.channelId)
	) {
		return;
	}

	// Strip bot mention from content
	const botId = client.user?.id;
	let content = message.content;
	if (botId) {
		content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
	}

	const attachments = await processAttachments(message);

	if (
		!content &&
		attachments.imageParts.length === 0 &&
		attachments.textBlocks.length === 0 &&
		attachments.notes.length === 0
	) {
		return;
	}

	const channelId = message.channelId;
	const state = getChannelState(channelId);

	const queued: QueuedMessage = {
		discordMessage: message,
		content,
		authorUsername: message.author.username,
		attachments,
		receivedAt: Date.now(),
	};

	state.queued.push(queued);

	if (state.active) {
		// A run is in progress — the message waits silently. The user can
		// start parallel work themselves (by the agent calling task_start
		// next turn) or interrupt via /stop. No queue-prompt UI.
		return;
	}

	await drainQueueAndRun(config, runtime, channelId);
}

/**
 * Pull every queued message off `state.queued`, combine them into a single
 * user turn, and run the agent loop. Loops if more messages arrive during
 * a turn so they drain together into the next one.
 */
async function drainQueueAndRun(
	config: DiscordConfig,
	runtime: HeadlessRuntime,
	channelId: string,
): Promise<void> {
	const state = getChannelState(channelId);

	while (state.queued.length > 0 && !state.active) {
		const batch = state.queued.splice(0, state.queued.length);
		const {userContent, imageParts} = buildCombinedUserContent(batch);
		const triggerMessage = batch[0].discordMessage;

		const controller = new AbortController();
		state.active = {
			controller,
			consumedIds: batch.map(b => b.discordMessage.id),
			startedAt: Date.now(),
			userContent,
			imageParts,
			triggerMessage,
		};

		try {
			await runAgentTurn({
				config,
				runtime,
				channelId,
				triggerMessage,
				userContent,
				imageParts,
				signal: controller.signal,
			});
		} catch (err) {
			console.error(`runAgentTurn escaped error in channel ${channelId}:`, err);
		} finally {
			state.active = null;
		}
	}
}

function buildCombinedUserContent(batch: QueuedMessage[]): {
	userContent: string;
	imageParts: MessageImagePart[];
} {
	const allImages: MessageImagePart[] = [];

	const renderOne = (m: QueuedMessage): string => {
		const guarded = guardMessageSize(m.content);
		const parts: string[] = [];
		if (guarded.content) parts.push(guarded.content);
		if (m.attachments.textBlocks.length > 0) {
			parts.push(m.attachments.textBlocks.join('\n\n'));
		}
		if (m.attachments.notes.length > 0) {
			parts.push(m.attachments.notes.join('\n'));
		}
		if (parts.length === 0 && m.attachments.imageParts.length > 0) {
			parts.push(
				`(${m.attachments.imageParts.length} image attachment${
					m.attachments.imageParts.length === 1 ? '' : 's'
				})`,
			);
		}
		return parts.join('\n\n');
	};

	for (const m of batch) {
		allImages.push(...m.attachments.imageParts);
	}

	if (batch.length === 1) {
		const m = batch[0];
		return {
			userContent: `[${m.authorUsername}]: ${renderOne(m)}`,
			imageParts: allImages,
		};
	}

	const sections = batch.map((m, i) => {
		const body = renderOne(m);
		return `**${i + 1}.** [${m.authorUsername}]: ${body}`;
	});
	const header = `The user sent ${batch.length} messages while I was working. They've been combined into one turn:`;
	return {
		userContent: `${header}\n\n${sections.join('\n\n---\n\n')}`,
		imageParts: allImages,
	};
}

// ─── Agent Turn ────────────────────────────────────────────────────────────

interface RunAgentTurnArgs {
	config: DiscordConfig;
	runtime: HeadlessRuntime;
	channelId: string;
	triggerMessage: DiscordJsMessage;
	userContent: string;
	imageParts: MessageImagePart[];
	signal: AbortSignal;
	sendTo?: TextChannel | ThreadChannel;
}

async function runAgentTurn(args: RunAgentTurnArgs): Promise<void> {
	const {
		config,
		runtime,
		channelId,
		triggerMessage,
		userContent,
		imageParts,
		signal,
	} = args;
	const guildId = triggerMessage.guild?.id;
	const conversationId = DiscordSessionStore.conversationId(channelId, guildId);

	// Get or create session
	let session = discordSessionStore.getSession(conversationId);
	if (!session) {
		session = await discordSessionStore.createSession({
			channelId,
			guildId,
			workingDirectory: defaultWorkingDirectory(config, channelId),
		});
	}
	await discordSessionStore.touchSession(conversationId);

	const workingDir = session.workingDirectory;

	// Switch to the channel's working directory before processing.
	// NOTE: this is a process-wide mutation and races with any concurrent
	// run in a *different* channel. Tasks inherit their parent channel's
	// cwd so tasks started from this channel all share the same cwd,
	// which is safe. Cross-channel races exist today and are out of scope
	// for the tasks v2 work — see TASKS_PLAN.md §1.3.
	const previousCwd = process.cwd();
	try {
		process.chdir(workingDir);
	} catch {
		process.chdir(config.workingDirectory);
	}

	// Load message history (auto-compact if too long)
	let messages = await messageStore.getMessages(conversationId);
	const llmClient = runtime.getClient();
	if (llmClient) {
		const compaction = await autoCompact(messages, llmClient);
		if (compaction.compacted) {
			messages = compaction.messages;
			await messageStore.saveMessages(conversationId, messages);
		}
	}

	const channel = args.sendTo ?? triggerMessage.channel;
	if (!('send' in channel)) return;
	const sendableChannel = channel as TextChannel | ThreadChannel;

	const statusLine = new StatusLine(sendableChannel);
	await statusLine.update('🔄 Thinking…');

	let lastStatusPhase: 'thinking' | 'tool' | 'approval' = 'thinking';
	let streamBuffer = '';
	let liveToolCount = 0;

	// Build the ACTIVE TASKS auto-inject block, using the *previous* turn's
	// start timestamp so we catch tasks that finished during the gap.
	const state = getChannelState(channelId);
	const previousTurnStartedAt = state.lastTurnStartedAt;
	state.lastTurnStartedAt = Date.now();
	const activeTasks = buildActiveTasksBlock(channelId, previousTurnStartedAt);

	// Prepend the ACTIVE TASKS block (if any) to the user turn content so
	// the agent sees it at the top of its context for this turn.
	const effectiveUserContent = activeTasks.text
		? `${activeTasks.text}\n\n---\n\n${userContent}`
		: userContent;

	try {
		const result = await withTaskInvocationContext(
			{
				parentChannelId: channelId,
				parentGuildId: guildId,
				parentTriggerMessage: triggerMessage,
			},
			() =>
				runtime.processMessage(
					messages,
					effectiveUserContent,
					session.mode,
					{
						onToken: (token: string) => {
							streamBuffer += token;
							if (lastStatusPhase !== 'thinking') {
								lastStatusPhase = 'thinking';
								void statusLine.update('🔄 Thinking…');
							}
						},
						onToolApproval: async toolCall => {
							lastStatusPhase = 'approval';
							void statusLine.update(
								`⏸ Waiting for approval on \`${toolCall.function.name}\`…`,
							);
							return requestToolApproval(sendableChannel, toolCall);
						},
						onToolStart: async (toolName, toolArgs) => {
							liveToolCount++;
							lastStatusPhase = 'tool';
							void statusLine.update(
								`🔄 ${formatToolStatus(toolName, toolArgs, liveToolCount)}`,
							);
						},
						onToolResult: async () => {},
					},
					signal,
					imageParts.length > 0 ? imageParts : undefined,
					{excludeTools: MAIN_CHANNEL_EXCLUDED_TOOLS},
				),
		);

		await messageStore.saveMessages(conversationId, result.messages);
		await discordSessionStore.updateSession(conversationId, {
			lastProcessedMessageId: triggerMessage.id,
		});

		// Mark the just-shown terminal tasks as acknowledged so they don't
		// reappear on the next turn.
		if (activeTasks.acknowledgeIds.length > 0) {
			await taskStore.acknowledge(activeTasks.acknowledgeIds);
		}

		const response = result.response.trim() || '*(no response)*';
		const chunks = splitMessage(response);
		for (const chunk of chunks) {
			await sendableChannel.send(chunk).catch(() => {});
		}

		await statusLine.clear();
		const toolSuffix =
			result.toolCallCount > 0
				? ` · ${result.toolCallCount} tool call${result.toolCallCount === 1 ? '' : 's'}`
				: '';
		await sendableChannel.send(`✅ Done${toolSuffix}`).catch(() => {});
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const wasCancelled =
			signal.aborted ||
			errorMsg.toLowerCase().includes('cancelled') ||
			errorMsg.toLowerCase().includes('aborted');

		await statusLine.clear();

		if (wasCancelled) {
			const buffered = streamBuffer.trim();
			const tail = buffered
				? `\n\n**Partial output before stop:**\n${truncate(buffered, 1500)}`
				: '';
			await sendableChannel
				.send(`⏹ Stopped.${tail}\n\nWhat would you like done differently?`)
				.catch(() => {});
		} else {
			await sendableChannel
				.send(`❌ Error: ${truncate(errorMsg, 1900)}`)
				.catch(() => {});
		}
	} finally {
		process.chdir(previousCwd);
	}
}

/** Human-readable verb for common tool names shown in the status line. */
const TOOL_VERBS: Record<string, string> = {
	read_file: 'Reading',
	write_file: 'Writing',
	string_replace: 'Editing',
	delete_file: 'Deleting',
	move_file: 'Moving',
	copy_file: 'Copying',
	create_directory: 'Creating dir',
	execute_bash: 'Running',
	search_files: 'Searching',
	glob: 'Globbing',
	grep: 'Grepping',
	web_fetch: 'Fetching',
	web_search: 'Searching web',
	git_commit: 'Committing',
	git_push: 'Pushing',
	git_pull: 'Pulling',
	git_add: 'Staging',
	git_branch: 'Branching',
	agent: 'Spawning agent',
	ask_user: 'Asking user',
	task_start: 'Starting task',
	task_status: 'Checking task',
	task_interrupt: 'Interrupting task',
	task_continue: 'Continuing task',
	task_wait: 'Waiting on task',
};

function formatToolStatus(
	toolName: string,
	args: Record<string, unknown>,
	toolCount: number,
): string {
	const verb = TOOL_VERBS[toolName] ?? toolName;
	const countStr = `· #${toolCount}`;

	if (!args || typeof args !== 'object') return `${verb} ${countStr}`;

	for (const key of [
		'path',
		'file_path',
		'command',
		'query',
		'url',
		'name',
		'title',
		'taskId',
	]) {
		if (key in args) {
			const v = args[key];
			if (typeof v === 'string' && v.length > 0) {
				return `${verb} \`${truncate(v, 60)}\` ${countStr}`;
			}
		}
	}
	return `${verb} ${countStr}`;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}

// ─── Project Creation ─────────────────────────────────────────────────────

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

async function handleProjectCreate(
	_config: DiscordConfig,
	interaction: ChatInputCommandInteraction,
	channelId: string,
	guildId: string | undefined,
	conversationId: string,
): Promise<void> {
	const {execSync} = await import('child_process');

	const name = interaction.options.getString('name', true).trim().toLowerCase();
	const description =
		interaction.options.getString('description') ?? 'A new project.';

	if (!PROJECT_NAME_RE.test(name)) {
		await interaction.reply({
			content:
				'❌ Invalid project name. Use lowercase letters, numbers, and hyphens only (e.g. `my-app`).',
			ephemeral: true,
		});
		return;
	}

	const projectDir = path.join('/root/projects', name);
	if (fs.existsSync(projectDir)) {
		await interaction.reply({
			content: `❌ Directory already exists: \`${projectDir}\`\nUse \`/cwd ${projectDir}\` to switch to it instead.`,
			ephemeral: true,
		});
		return;
	}

	await interaction.deferReply();

	const steps: string[] = [];
	try {
		fs.mkdirSync(projectDir, {recursive: true});
		execSync('git init', {cwd: projectDir, stdio: 'pipe'});
		execSync('git checkout -b dev', {cwd: projectDir, stdio: 'pipe'});
		steps.push('📁 Directory and git repo created');

		const claudeMd = `# ${name}\n\n## Development Commands\n\n\`\`\`bash\n# Add your build/run/test commands here\n\`\`\`\n\n## Architecture\n\nDescribe the project structure here.\n`;
		const visionMd = `# Vision\n\n## What This Is\n${description}\n\n## End Goal\n<!-- What does the fully realised version look like? -->\n\n## Core Principles\n- <!-- Add guiding constraints -->\n\n## Non-Goals\n- <!-- What this project explicitly does NOT do -->\n`;
		const todoMd = `# TODO\n\n## Now\n- [ ] Define the project vision in VISION.md\n\n## Next\n\n## Later\n\n## Done\n- [x] Project scaffolded\n`;

		fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), claudeMd);
		fs.writeFileSync(path.join(projectDir, 'VISION.md'), visionMd);
		fs.writeFileSync(path.join(projectDir, 'TODO.md'), todoMd);
		steps.push('📝 CLAUDE.md, VISION.md, TODO.md created');

		execSync('git add .', {cwd: projectDir, stdio: 'pipe'});
		execSync('git commit -m "Initial project setup"', {
			cwd: projectDir,
			stdio: 'pipe',
		});
		steps.push('✅ Initial commit on `dev`');

		const repoUrl = `https://github.com/Derek-Studio/${name}`;
		try {
			execSync(
				`gh repo create Derek-Studio/${name} --private --source=. --remote=origin --push`,
				{cwd: projectDir, stdio: 'pipe'},
			);
			steps.push(`🐙 GitHub repo created: ${repoUrl}`);
		} catch {
			steps.push('⚠️ GitHub repo creation failed — project is local only');
		}

		await discordSessionStore.deleteSession(conversationId);
		await messageStore.clearMessages(conversationId);
		await discordSessionStore.createSession({
			channelId,
			guildId,
			workingDirectory: projectDir,
		});
		steps.push(`🔗 Channel linked to \`${projectDir}\``);

		await interaction.editReply(
			[
				`✅ **Project \`${name}\` created**`,
				'',
				steps.join('\n'),
				'',
				`📌 Next: fill in \`VISION.md\` with where this project is going.`,
			].join('\n'),
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await interaction.editReply(
			`❌ Project creation failed at step ${steps.length + 1}:\n\`\`\`\n${msg}\n\`\`\`\n\nCompleted steps:\n${steps.join('\n') || '(none)'}`,
		);
	}
}

// ─── Slash Command Handling ────────────────────────────────────────────────

async function handleSlashCommand(
	client: Client,
	config: DiscordConfig,
	runtime: HeadlessRuntime,
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	const channelId = interaction.channelId;
	const guildId = interaction.guildId ?? undefined;
	const conversationId = DiscordSessionStore.conversationId(channelId, guildId);

	switch (interaction.commandName) {
		case 'cwd': {
			const newPath = interaction.options.getString('path') ?? null;
			const session = discordSessionStore.getSession(conversationId);
			const currentCwd =
				session?.workingDirectory ?? defaultWorkingDirectory(config, channelId);

			if (!newPath) {
				// Show current cwd and which hydration files exist
				const hydrationFiles = ['AGENTS.md', 'VISION.md', 'TODO.md'].map(
					name => {
						const exists = fs.existsSync(path.join(currentCwd, name));
						return `${exists ? '✅' : '❌'} \`${name}\``;
					},
				);
				await interaction.reply(
					`📁 \`${currentCwd}\`\n\n**Prompt hydration files:**\n${hydrationFiles.join('\n')}`,
				);
			} else {
				// Update session cwd in-place, no history clear
				if (!fs.existsSync(newPath)) {
					await interaction.reply({
						content: `❌ Directory not found: \`${newPath}\``,
						ephemeral: true,
					});
					break;
				}
				if (session) {
					await discordSessionStore.updateSession(conversationId, {
						workingDirectory: newPath,
					});
				} else {
					await discordSessionStore.createSession({
						channelId,
						guildId,
						workingDirectory: newPath,
					});
				}
				const hydrationFiles = ['AGENTS.md', 'VISION.md', 'TODO.md'].map(
					name => {
						const exists = fs.existsSync(path.join(newPath, name));
						return `${exists ? '✅' : '❌'} \`${name}\``;
					},
				);
				await interaction.reply(
					`📁 Working directory updated to \`${newPath}\`\n\n**Prompt hydration files:**\n${hydrationFiles.join('\n')}`,
				);
			}
			break;
		}

		case 'fork': {
			const threadName =
				interaction.options.getString('name') ?? 'Forked session';
			const channel = interaction.channel;

			if (
				!channel ||
				(channel.type !== ChannelType.GuildText &&
					channel.type !== ChannelType.PublicThread &&
					channel.type !== ChannelType.PrivateThread)
			) {
				await interaction.reply({
					content: '❌ Fork only works in text channels.',
					ephemeral: true,
				});
				return;
			}

			await interaction.deferReply();

			const parentMessages = await messageStore.getMessages(conversationId);

			const reply = await interaction.fetchReply();
			const thread = await (reply as DiscordJsMessage).startThread({
				name: `🔀 ${threadName.slice(0, 95)}`,
				autoArchiveDuration: 1440,
			});

			const threadConvId = DiscordSessionStore.conversationId(
				thread.id,
				guildId,
			);
			await discordSessionStore.forkSession(conversationId, thread.id, guildId);
			await messageStore.saveMessages(threadConvId, [...parentMessages]);

			await interaction.editReply(
				`🔀 Forked session into thread **${threadName}** with ${parentMessages.length} messages.`,
			);
			await thread.send(
				`📋 Session forked from <#${channelId}> with ${parentMessages.length} messages of context.`,
			);
			break;
		}

		case 'status': {
			const session = discordSessionStore.getSession(conversationId);
			const messages = await messageStore.getMessages(conversationId);

			if (!session) {
				await interaction.reply({
					content: 'No active session in this channel.',
					ephemeral: true,
				});
				return;
			}

			await interaction.reply(
				formatSessionStatus({
					model: session.model || runtime.getModel(),
					provider: session.provider || runtime.getProvider(),
					mode: session.mode,
					messageCount: messages.length,
					estimatedTokens: estimateTokens(messages),
					workingDirectory: session.workingDirectory,
					sessionId: session.sessionId,
				}),
			);
			break;
		}

		case 'model': {
			const model = interaction.options.getString('name', true);
			runtime.setModel(model);
			await discordSessionStore.updateSession(conversationId, {model});
			await interaction.reply(`🤖 Model switched to **${model}**`);
			break;
		}

		case 'provider': {
			const provider = interaction.options.getString('name', true);
			await discordSessionStore.updateSession(conversationId, {provider});
			await interaction.reply(
				`🔌 Provider switched to **${provider}**. Note: a new runtime initialization may be needed for provider changes to fully take effect.`,
			);
			break;
		}

		case 'clear': {
			await messageStore.clearMessages(conversationId);
			await interaction.reply('🗑️ Conversation history cleared.');
			break;
		}

		case 'compact': {
			await interaction.deferReply();
			const messages = await messageStore.getMessages(conversationId);
			if (messages.length < 10) {
				await interaction.editReply('Not enough messages to compact.');
				return;
			}

			const llmClient = runtime.getClient();
			if (!llmClient) {
				await interaction.editReply('❌ Runtime not ready.');
				return;
			}

			const tokens = Math.round(
				messages.reduce((s, m) => {
					const t =
						typeof m.content === 'string'
							? m.content
							: JSON.stringify(m.content);
					return s + t.length / 4;
				}, 0),
			);
			await interaction.editReply(
				`⏳ Summarising ${messages.length} messages (~${tokens.toLocaleString()} tokens)...`,
			);

			const result = await autoCompact(messages, llmClient, true);
			await messageStore.saveMessages(conversationId, result.messages);
			const method =
				result.method === 'llm' ? 'LLM summary' : 'hard truncation';
			await interaction.editReply(
				`📦 Compacted ${result.originalCount} → ${result.messages.length} messages via ${method} (~${result.estimatedTokens.toLocaleString()} tokens freed).`,
			);
			break;
		}

		case 'mode': {
			const mode = interaction.options.getString(
				'mode',
				true,
			) as DiscordDevelopmentMode;
			await discordSessionStore.updateSession(conversationId, {mode});
			const icons: Record<string, string> = {
				normal: '▶',
				'auto-accept': '⏵⏵',
				yolo: '⏵⏵⏵',
			};
			await interaction.reply(`${icons[mode] || '⚡'} Mode set to **${mode}**`);
			break;
		}

		case 'sessions': {
			const sessions = discordSessionStore.listSessions();
			if (sessions.length === 0) {
				await interaction.reply({
					content: 'No sessions found.',
					ephemeral: true,
				});
				return;
			}

			const lines = sessions.slice(0, 20).map((s, i) => {
				const date = new Date(s.lastActiveAt).toLocaleDateString();
				return `${i + 1}. <#${s.channelId}> — ${s.mode} — ${date} — \`${s.sessionId.slice(0, 8)}…\``;
			});

			await interaction.reply({
				content: `**Recent Sessions**\n${lines.join('\n')}`,
				ephemeral: true,
			});
			break;
		}

		case 'restart': {
			await interaction.reply('♻️ Restarting...');
			console.log('Restart requested via Discord slash command.');
			client.destroy();
			process.exit(0);
			break;
		}

		case 'rebuild': {
			await interaction.reply('🔨 Building...');
			const {exec} = await import('node:child_process');
			const {fileURLToPath} = await import('node:url');
			const projectRoot = path.resolve(
				fileURLToPath(import.meta.url),
				'../../..',
			);
			exec(
				'pnpm run build',
				{cwd: projectRoot},
				async (err, _stdout, stderr) => {
					if (err) {
						const output = stderr.slice(-1800) || err.message;
						await interaction.editReply(
							`❌ Build failed:\n\`\`\`\n${output}\n\`\`\``,
						);
						return;
					}
					await interaction.editReply('✅ Build complete, restarting...');
					client.destroy();
					process.exit(0);
				},
			);
			break;
		}

		case 'stop': {
			const scope = interaction.options.getString('scope') ?? 'channel';

			// Task-scoped stop: `task:<id>` cancels a specific task.
			if (scope.startsWith('task:')) {
				const taskId = scope.slice('task:'.length);
				const task = await interruptTask(taskId, 'stopped by operator');
				if (!task) {
					await interaction.reply({
						content: `⚠️ Task \`${taskId}\` not found.`,
						ephemeral: true,
					});
				} else {
					await interaction.reply({
						content: `⏹ Interrupting task \`${taskId}\`.`,
						ephemeral: true,
					});
				}
				break;
			}

			if (scope === 'all') {
				let stopped = 0;
				for (const state of channelStates.values()) {
					if (state.active) {
						state.active.controller.abort();
						state.queued = [];
						stopped++;
					}
				}
				// Sweep all known channels for active tasks and interrupt them.
				const seenTasks = new Set<string>();
				for (const cid of channelStates.keys()) {
					for (const t of taskStore.listActiveForChannel(cid)) {
						if (!seenTasks.has(t.id)) {
							seenTasks.add(t.id);
							await interruptTask(t.id, 'stopped by operator');
						}
					}
				}
				const taskCount = seenTasks.size;
				await interaction.reply({
					content:
						stopped > 0 || taskCount > 0
							? `⏹ Stopped ${stopped} active run${stopped === 1 ? '' : 's'} and ${taskCount} task${taskCount === 1 ? '' : 's'}.`
							: 'Nothing running anywhere right now.',
					ephemeral: true,
				});
				break;
			}

			// Default: channel scope
			const state = channelStates.get(channelId);
			if (!state || !state.active) {
				await interaction.reply({
					content: 'Nothing running in this channel right now.',
					ephemeral: true,
				});
				return;
			}
			state.active.controller.abort();
			state.queued = [];
			await interaction.reply({content: '⏹ Stopping.', ephemeral: true});
			break;
		}

		case 'bash': {
			const command = interaction.options.getString('command', true);
			const session = discordSessionStore.getSession(conversationId);
			const cwd = session?.workingDirectory ?? config.workingDirectory;

			await interaction.deferReply();
			try {
				const {execSync} = await import('child_process');
				const output = execSync(command, {
					cwd,
					stdio: 'pipe',
					timeout: 30000,
				})
					.toString()
					.trim();
				const body =
					output.length > 0
						? `\`\`\`\n${output.slice(0, 1800)}\n\`\`\``
						: '*(no output)*';
				await interaction.editReply(`📁 \`${cwd}\` — \`${command}\`\n${body}`);
			} catch (err) {
				const e = err as Record<string, unknown>;
				const msg = (
					String(e['stdout'] ?? '') ||
					String(e['stderr'] ?? '') ||
					String(err)
				).trim();
				await interaction.editReply(
					`❌ \`${command}\` (in \`${cwd}\`)\n\`\`\`\n${msg.slice(0, 1800)}\n\`\`\``,
				);
			}
			break;
		}

		case 'project': {
			const subcommand = interaction.options.getSubcommand();
			if (subcommand === 'create') {
				await handleProjectCreate(
					config,
					interaction,
					channelId,
					guildId,
					conversationId,
				);
			}
			break;
		}

		default:
			await interaction.reply({
				content: `Unknown command: ${interaction.commandName}`,
				ephemeral: true,
			});
	}
}

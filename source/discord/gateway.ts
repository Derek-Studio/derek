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
import {HeadlessRuntime} from './runtime/headless-runtime.js';
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
import type {DiscordConfig, DiscordDevelopmentMode} from './types.js';
import {formatSessionStatus} from './ui/message-formatter.js';
import {splitMessage} from './ui/message-splitter.js';
import {
	parseQueueButtonId,
	QUEUE_BUTTON_PREFIX,
	QueuePrompt,
} from './ui/queue-prompt.js';
import {StatusLine} from './ui/status-line.js';

// ─── Per-Channel State Machine ─────────────────────────────────────────────
//
// Each channel carrying a conversation has a single ChannelRunState that
// tracks whether Derek is currently running a turn and what messages have
// arrived while he was busy. At most one agent turn runs per channel at
// any time. Messages that arrive during an active run are queued and
// drained as a single combined turn when the active run completes.
//
// This replaces the previous promise-chain `channelLocks` approach, which
// serialised correctly but made it hard to (a) see how many messages
// were queued up, (b) expose buttons to redirect them, and (c) combine
// multiple queued messages into a single turn.

/** One queued user message, fully resolved (attachments already processed). */
interface QueuedMessage {
	/** The raw discord.js Message — retained so we can start threads off it. */
	discordMessage: DiscordJsMessage;
	/** Bot-mention-stripped content. May be empty if message was just attachments. */
	content: string;
	authorUsername: string;
	/** Pre-processed attachments: images + inlined text blocks + skip notes. */
	attachments: ProcessedAttachments;
	receivedAt: number;
}

interface ActiveRun {
	controller: AbortController;
	/** The set of queued-message ids that this run consumed, for display. */
	consumedIds: string[];
	startedAt: number;
}

interface ChannelRunState {
	/** Non-null iff a `runAgentTurn` is currently executing for this channel. */
	active: ActiveRun | null;
	/** Messages received while `active` was non-null. Drained into next run. */
	queued: QueuedMessage[];
	/** UI message offering buttons when `queued.length > 0 && active !== null`. */
	queuePrompt: QueuePrompt | null;
}

const channelStates = new Map<string, ChannelRunState>();

function getChannelState(channelId: string): ChannelRunState {
	let state = channelStates.get(channelId);
	if (!state) {
		state = {active: null, queued: [], queuePrompt: null};
		channelStates.set(channelId, state);
	}
	return state;
}

/**
 * Resolve the working directory for a new session in a channel.
 * For existing sessions, session.workingDirectory takes priority — see processUserMessage.
 */
function defaultWorkingDirectory(config: DiscordConfig): string {
	return config.workingDirectory;
}

const MISSED_MESSAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // ignore messages older than 24h

/**
 * On startup, fetch messages that arrived in active channels while the bot was offline
 * and process them in order so nothing gets dropped during restarts.
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

			// Fetch messages after the last one we processed (Discord returns newest-first,
			// but `after` returns in ascending order so we get chronological order)
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

			// Process each missed message in order through the normal handler
			// (channel lock ensures they're serialised)
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
			if (
				interaction.isButton() &&
				interaction.customId.startsWith(`${QUEUE_BUTTON_PREFIX}:`)
			) {
				await handleQueueButton(interaction);
				return;
			}
			// Other component interactions (tool-approval buttons) are
			// awaited via awaitMessageComponent inside requestToolApproval,
			// not routed through here.
		} catch (error) {
			console.error('Error handling interaction:', error);
			if (interaction.isRepliable() && !interaction.replied) {
				await interaction
					.reply({content: '❌ An error occurred.', ephemeral: true})
					.catch(() => {});
			}
		}
	});

	// On startup, process any messages that arrived while the bot was offline
	client.once('clientReady', () => {
		replayMissedMessages(client, config, runtime).catch(err => {
			console.error('Error replaying missed messages:', err);
		});
	});
}

// ─── Message Ingestion ────────────────────────────────────────────────────
//
// `handleMessage` is the single entry point for incoming Discord messages.
// It validates allowlists, resolves attachments, then enqueues the message
// against the channel's state. If no run is active, it kicks off
// `drainQueueAndRun`. Otherwise the message sits in the queue until the
// active run completes, at which point all pending messages are combined
// into one user turn.

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

	// Skip silently if there's nothing actionable
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
		// A run is in progress — leave the message queued and surface a
		// prompt with the redirect buttons. Prompt edits in place as more
		// messages queue.
		const channel = message.channel;
		if ('send' in channel) {
			const sendable = channel as TextChannel | ThreadChannel;
			if (!state.queuePrompt) {
				const nonce = makeQueueNonce();
				state.queuePrompt = new QueuePrompt(sendable, nonce);
			}
			void state.queuePrompt.update(state.queued.length);
		}
		return;
	}

	// No active run — start draining immediately.
	await drainQueueAndRun(config, runtime, channelId);
}

/**
 * Random nonce embedded in queue-prompt button customIds so we can detect
 * stale presses (button from an earlier prompt that's since been replaced).
 */
function makeQueueNonce(): string {
	return Math.random().toString(36).slice(2, 10);
}

/**
 * Pull every queued message off `state.queued`, combine them into a single
 * user turn, and run the agent loop. On completion, recurse if more messages
 * arrived during the run.
 *
 * Idempotent: returns immediately if already running. The caller is expected
 * to hold off and let the outer state machine call us again.
 */
async function drainQueueAndRun(
	config: DiscordConfig,
	runtime: HeadlessRuntime,
	channelId: string,
): Promise<void> {
	const state = getChannelState(channelId);

	// Loop in case more messages arrive during a turn — drain them together
	// in the next iteration rather than firing two separate runs.
	while (state.queued.length > 0 && !state.active) {
		const batch = state.queued.splice(0, state.queued.length);
		// The queue is being drained into a turn — the prompt is no longer
		// actionable. Dismiss it before the run starts.
		if (state.queuePrompt) {
			void state.queuePrompt.dismiss();
			state.queuePrompt = null;
		}
		const {userContent, imageParts} = buildCombinedUserContent(batch);

		// `triggerMessage` is the message we anchor a thread off if we ever
		// need to. The first message in the batch is conventional.
		const triggerMessage = batch[0].discordMessage;

		const controller = new AbortController();
		state.active = {
			controller,
			consumedIds: batch.map(b => b.discordMessage.id),
			startedAt: Date.now(),
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
			// runAgentTurn handles its own UI for errors/cancellation. If
			// something escapes (programming error) log it loudly so we know.
			console.error(`runAgentTurn escaped error in channel ${channelId}:`, err);
		} finally {
			state.active = null;
		}
		// Loop continues if more messages queued up while we were running.
	}
}

/**
 * Combine N queued messages into a single user-content payload + merged image
 * list. Single-message form preserves today's `[username]: ...` framing.
 * Multi-message form uses a numbered list so the LLM can see the messages
 * are distinct (per spec — they may matter as separate thoughts).
 */
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

	// Multiple messages — present as a list. The framing tells the model that
	// these were sent as separate Discord messages (so order/segmentation
	// might be meaningful) but should be addressed together as one turn.
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
	/** Discord message we should anchor any thread/UI off. */
	triggerMessage: DiscordJsMessage;
	userContent: string;
	imageParts: MessageImagePart[];
	signal: AbortSignal;
}

/**
 * Run a single agent turn against the given channel's session, posting the
 * standard StatusLine + durable response + Done marker UX. Throws on fatal
 * errors after rendering them in the channel.
 *
 * Extracted from the old `processUserMessage` so Phase 4+ can call it for
 * forked-thread runs as well as main-channel runs.
 */
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

	// Get or create session — existing session CWD takes priority over defaults
	let session = discordSessionStore.getSession(conversationId);
	if (!session) {
		session = await discordSessionStore.createSession({
			channelId,
			guildId,
			workingDirectory: defaultWorkingDirectory(config),
		});
	}
	await discordSessionStore.touchSession(conversationId);

	const workingDir = session.workingDirectory;

	// Switch to the channel's working directory before processing
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

	const channel = triggerMessage.channel;
	if (!('send' in channel)) return;
	const sendableChannel = channel as TextChannel | ThreadChannel;

	const statusLine = new StatusLine(sendableChannel);
	await statusLine.update('🔄 Thinking…');

	let lastStatusPhase: 'thinking' | 'tool' | 'approval' = 'thinking';
	let streamBuffer = '';

	try {
		const result = await runtime.processMessage(
			messages,
			userContent,
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
					lastStatusPhase = 'tool';
					void statusLine.update(`🔄 ${formatToolStatus(toolName, toolArgs)}`);
				},
				onToolResult: async () => {
					// No-op — next onToken or onToolStart updates the status.
				},
			},
			signal,
			imageParts.length > 0 ? imageParts : undefined,
		);

		await messageStore.saveMessages(conversationId, result.messages);
		await discordSessionStore.updateSession(conversationId, {
			lastProcessedMessageId: triggerMessage.id,
		});

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

/**
 * Short one-line summary of a tool invocation for the status bar, e.g.
 * "read_file source/foo.ts" or "execute_bash tsc --noEmit".
 */
function formatToolStatus(
	toolName: string,
	args: Record<string, unknown>,
): string {
	if (!args || typeof args !== 'object') return `\`${toolName}\``;
	// Prefer the most identifying argument for common tools.
	for (const key of ['path', 'file_path', 'command', 'query', 'url', 'name']) {
		if (key in args) {
			const v = args[key];
			if (typeof v === 'string' && v.length > 0) {
				return `\`${toolName}\` ${truncate(v, 80)}`;
			}
		}
	}
	return `\`${toolName}\``;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…`;
}

// ─── Queue Prompt Button Handler ──────────────────────────────────────────

/**
 * Handle a press on one of the queue-prompt buttons. Phase 3 ships with
 * dummy handlers: we acknowledge the press, strip the buttons, and drop a
 * placeholder note. Phases 5 and 6 wire up the real "run in background"
 * and "swap to thread" behaviour.
 *
 * Imported type from discord.js lazily via Parameters<...>['0'] to avoid
 * another top-level import.
 */
async function handleQueueButton(
	interaction: import('discord.js').ButtonInteraction,
): Promise<void> {
	const parsed = parseQueueButtonId(interaction.customId);
	if (!parsed) {
		await interaction
			.reply({content: '❌ Unknown queue action.', ephemeral: true})
			.catch(() => {});
		return;
	}

	const channelId = interaction.channelId;
	const state = channelStates.get(channelId);

	// Detect stale presses: the prompt this button came from might have been
	// replaced by a newer one, or already dismissed. In either case, refuse.
	if (
		!state ||
		!state.queuePrompt ||
		state.queuePrompt.nonce !== parsed.nonce
	) {
		await interaction
			.reply({
				content:
					'⚠️ This queue prompt is no longer active (a newer one replaced it, or the queue already drained).',
				ephemeral: true,
			})
			.catch(() => {});
		return;
	}

	if (parsed.action === 'background') {
		// Phase 5 will fork the queue into a background thread. For now:
		await state.queuePrompt.dismiss({
			keep: true,
			note: `🔀 *[stub] Would fork ${state.queued.length} queued message(s) into a background thread with forked context. Not implemented yet — messages will still run in-channel after the current turn.*`,
		});
		state.queuePrompt = null;
		await interaction
			.reply({
				content:
					'🔀 Background-fork action recorded (Phase 5 not implemented yet). Queued messages will still run in-channel.',
				ephemeral: true,
			})
			.catch(() => {});
		return;
	}

	if (parsed.action === 'swap_to_thread') {
		// Phase 6 will abort the current run and move it to a thread. For now:
		await state.queuePrompt.dismiss({
			keep: true,
			note: '🧵 *[stub] Would move the currently-running turn into a forked thread and free the main channel for the queued messages. Not implemented yet.*',
		});
		state.queuePrompt = null;
		await interaction
			.reply({
				content:
					'🧵 Swap-to-thread action recorded (Phase 6 not implemented yet). Current run continues as normal.',
				ephemeral: true,
			})
			.catch(() => {});
		return;
	}
}

// ─── Project Creation ─────────────────────────────────────────────────────

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

async function handleProjectCreate(
	config: DiscordConfig,
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
			content: `❌ Directory already exists: \`${projectDir}\`\nUse \`/new cwd:${projectDir}\` to link this channel to it instead.`,
			ephemeral: true,
		});
		return;
	}

	await interaction.deferReply();

	const steps: string[] = [];
	try {
		// 1. Create directory and git repo
		fs.mkdirSync(projectDir, {recursive: true});
		execSync('git init', {cwd: projectDir, stdio: 'pipe'});
		execSync('git checkout -b dev', {cwd: projectDir, stdio: 'pipe'});
		steps.push('📁 Directory and git repo created');

		// 2. Write starter files
		const claudeMd = `# ${name}\n\n## Development Commands\n\n\`\`\`bash\n# Add your build/run/test commands here\n\`\`\`\n\n## Architecture\n\nDescribe the project structure here.\n`;
		const visionMd = `# Vision\n\n## What This Is\n${description}\n\n## End Goal\n<!-- What does the fully realised version look like? -->\n\n## Core Principles\n- <!-- Add guiding constraints -->\n\n## Non-Goals\n- <!-- What this project explicitly does NOT do -->\n`;
		const todoMd = `# TODO\n\n## Now\n- [ ] Define the project vision in VISION.md\n\n## Next\n\n## Later\n\n## Done\n- [x] Project scaffolded\n`;

		fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), claudeMd);
		fs.writeFileSync(path.join(projectDir, 'VISION.md'), visionMd);
		fs.writeFileSync(path.join(projectDir, 'TODO.md'), todoMd);
		steps.push('📝 CLAUDE.md, VISION.md, TODO.md created');

		// 3. Initial commit
		execSync('git add .', {cwd: projectDir, stdio: 'pipe'});
		execSync('git commit -m "Initial project setup"', {
			cwd: projectDir,
			stdio: 'pipe',
		});
		steps.push('✅ Initial commit on `dev`');

		// 4. Create GitHub repo and push
		const repoUrl = `https://github.com/Derek-Studio/${name}`;
		try {
			execSync(
				`gh repo create Derek-Studio/${name} --private --source=. --remote=origin --push`,
				{cwd: projectDir, stdio: 'pipe'},
			);
			steps.push(`🐙 GitHub repo created: ${repoUrl}`);
		} catch {
			// GitHub creation failed — still usable locally
			steps.push('⚠️ GitHub repo creation failed — project is local only');
		}

		// 5. Link this channel to the new project
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

// ─── Background Task Runner ───────────────────────────────────────────────

const TASK_UPDATE_INTERVAL = 8; // post a streaming update every N tool calls

async function runBackgroundTask(
	runtime: HeadlessRuntime,
	thread: ThreadChannel,
	prompt: string,
	cwd: string,
	mode: DiscordDevelopmentMode,
	guildId: string | undefined,
	originChannelId: string,
	userId: string,
): Promise<void> {
	// Background tasks do NOT chdir — that would race with concurrent foreground messages
	// sharing the same Node.js process. Tool calls that need cwd receive it via the prompt.
	void cwd;

	let toolCallsSinceUpdate = 0;
	let currentStepMsg: DiscordJsMessage | null = null;

	try {
		const result = await runtime.processMessage(
			[], // fresh history — background tasks are isolated
			prompt,
			mode,
			{
				onToken: () => {
					// We don't stream token-by-token into the thread — post on completion
				},
				onToolApproval: async () => 'approve', // always approve in background
				onToolStart: async (toolName, args) => {
					toolCallsSinceUpdate++;
					// Post a brief status update every N tool calls so progress is visible
					if (toolCallsSinceUpdate % TASK_UPDATE_INTERVAL === 1) {
						const argStr = JSON.stringify(args).slice(0, 80);
						currentStepMsg = await thread
							.send(`🔧 \`${toolName}\` — ${argStr}…`)
							.catch(() => null);
					}
				},
				onToolResult: async () => {},
			},
		);

		// Post the final response to the thread
		const chunks = splitMessage(
			result.response || '*(task complete — no output)*',
		);
		for (const chunk of chunks) {
			await thread.send(chunk).catch(() => {});
		}

		// Ping the user in the origin channel
		const originChannel = thread.parent;
		if (originChannel && 'send' in originChannel) {
			await (originChannel as TextChannel).send(
				`<@${userId}> ✅ Background task finished — ${result.toolCallCount} tool calls. See ${thread}.`,
			);
		}
	} finally {
		void currentStepMsg;
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
		case 'new': {
			const cwd =
				interaction.options.getString('cwd') ?? config.workingDirectory;
			const model = interaction.options.getString('model') ?? undefined;
			const provider = interaction.options.getString('provider') ?? undefined;

			// Delete existing session
			await discordSessionStore.deleteSession(conversationId);
			await messageStore.clearMessages(conversationId);

			// Create fresh session
			await discordSessionStore.createSession({
				channelId,
				guildId,
				workingDirectory: cwd,
				model,
				provider,
			});

			// Switch model/provider in runtime if specified
			if (model) runtime.setModel(model);

			await interaction.reply(
				`✅ New session created.\n📁 \`${cwd}\`${model ? `\n🤖 ${model}` : ''}`,
			);
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

			// Copy message history to the new thread session
			const parentMessages = await messageStore.getMessages(conversationId);

			// Create a thread
			const reply = await interaction.fetchReply();
			const thread = await (reply as DiscordJsMessage).startThread({
				name: `🔀 ${threadName.slice(0, 95)}`,
				autoArchiveDuration: 1440,
			});

			// Create session for the thread
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
			await discordSessionStore.updateSession(conversationId, {
				provider,
			});
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

			const client = runtime.getClient();
			if (!client) {
				await interaction.editReply('❌ Runtime not ready.');
				return;
			}

			const estimatedTokens = Math.round(
				messages.reduce((s, m) => {
					const t =
						typeof m.content === 'string'
							? m.content
							: JSON.stringify(m.content);
					return s + t.length / 4;
				}, 0),
			);
			await interaction.editReply(
				`⏳ Summarising ${messages.length} messages (~${estimatedTokens.toLocaleString()} tokens)...`,
			);

			const result = await autoCompact(messages, client, true);
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
			// Disconnect cleanly, then exit with code 0.
			// A process manager (pm2, systemd, shell loop) should restart the process.
			client.destroy();
			process.exit(0);
			break;
		}

		case 'stop': {
			const state = channelStates.get(channelId);
			if (!state || !state.active) {
				await interaction.reply({
					content: 'Nothing running in this channel right now.',
					ephemeral: true,
				});
				return;
			}
			state.active.controller.abort();
			// Clear the queue so drained messages don't auto-run after the stop.
			if (state.queuePrompt) {
				void state.queuePrompt.dismiss();
				state.queuePrompt = null;
			}
			state.queued = [];
			// state.active is cleared by drainQueueAndRun's finally block
			// once the abort propagates through runAgentTurn.
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

		case 'task': {
			const prompt = interaction.options.getString('prompt', true);
			const session = discordSessionStore.getSession(conversationId);
			const taskCwd = session?.workingDirectory ?? config.workingDirectory;
			const taskMode = session?.mode ?? 'auto-accept';

			const channel = interaction.channel;
			if (
				!channel ||
				(channel.type !== ChannelType.GuildText &&
					channel.type !== ChannelType.PublicThread &&
					channel.type !== ChannelType.PrivateThread)
			) {
				await interaction.reply({
					content: '❌ Background tasks require a text channel.',
					ephemeral: true,
				});
				return;
			}

			// Reply immediately so the user can keep chatting
			await interaction.reply(
				`⚡ Task started in a thread. I'll post updates there and ping you when done.`,
			);

			// Create a thread for the background task
			const reply = await interaction.fetchReply();
			const thread = await (reply as DiscordJsMessage).startThread({
				name: `⚙️ ${prompt.slice(0, 90)}`,
				autoArchiveDuration: 1440,
			});

			// Fire-and-forget — does not hold the channel lock
			runBackgroundTask(
				runtime,
				thread,
				prompt,
				taskCwd,
				taskMode,
				guildId,
				channelId,
				interaction.user.id,
			).catch(err => {
				const msg = err instanceof Error ? err.message : String(err);
				thread.send(`❌ Task crashed: ${msg}`).catch(() => {});
			});
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

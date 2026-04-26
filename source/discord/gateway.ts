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
import {processAttachments} from './attachments.js';
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
import {StatusLine} from './ui/status-line.js';

/** Per-channel processing lock to prevent concurrent responses. */
const channelLocks = new Map<string, Promise<void>>();

/**
 * Per-channel AbortController for the currently-running `processUserMessage`.
 * `/stop` looks this up to interrupt the in-flight LLM/tool loop so the user
 * can give new feedback when Derek is going down the wrong path.
 */
const activeRuns = new Map<string, AbortController>();

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
		if (!interaction.isChatInputCommand()) return;
		try {
			await handleSlashCommand(
				client,
				config,
				runtime,
				interaction as ChatInputCommandInteraction,
			);
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

// ─── Message Handling ──────────────────────────────────────────────────────

async function handleMessage(
	client: Client,
	config: DiscordConfig,
	runtime: HeadlessRuntime,
	message: DiscordJsMessage,
): Promise<void> {
	// Ignore bots (including self)
	if (message.author.bot) return;

	// Check guild allowlist
	if (
		message.guild &&
		config.guildIds.length > 0 &&
		!config.guildIds.includes(message.guild.id)
	) {
		return;
	}

	// Check channel allowlist
	if (
		config.allowedChannelIds.length > 0 &&
		!config.allowedChannelIds.includes(message.channelId)
	) {
		return;
	}

	// Strip bot mention from content (if someone still @mentions)
	const botId = client.user?.id;
	let content = message.content;
	if (botId) {
		content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
	}

	// Process attachments: images → imageParts, text files → inlined blocks,
	// anything else → a note so the agent knows it was sent.
	const attachments = await processAttachments(message);

	// Skip silently if there's nothing actionable (no text, no attachments).
	if (
		!content &&
		attachments.imageParts.length === 0 &&
		attachments.textBlocks.length === 0 &&
		attachments.notes.length === 0
	) {
		return;
	}

	// Guard against single messages that would instantly overflow context
	const guarded = guardMessageSize(content);

	// Build the user-facing text payload. Caption first (may be empty),
	// then inlined text files, then any skip notes.
	const parts: string[] = [];
	if (guarded.content) parts.push(guarded.content);
	if (attachments.textBlocks.length > 0)
		parts.push(attachments.textBlocks.join('\n\n'));
	if (attachments.notes.length > 0) parts.push(attachments.notes.join('\n'));
	// If the user sent *only* images with no caption, give the LLM a tiny hint.
	if (parts.length === 0 && attachments.imageParts.length > 0) {
		parts.push(
			`(${attachments.imageParts.length} image attachment${
				attachments.imageParts.length === 1 ? '' : 's'
			})`,
		);
	}
	const userContent = `[${message.author.username}]: ${parts.join('\n\n')}`;

	// Serialize per-channel to prevent interleaved responses
	const channelId = message.channelId;
	const prev = channelLocks.get(channelId) ?? Promise.resolve();
	const current = prev.then(() =>
		processUserMessage(
			client,
			config,
			runtime,
			message,
			userContent,
			attachments.imageParts,
		),
	);
	channelLocks.set(
		channelId,
		current.catch(() => {}),
	);
	await current;
}

async function processUserMessage(
	client: Client,
	config: DiscordConfig,
	runtime: HeadlessRuntime,
	message: DiscordJsMessage,
	userContent: string,
	imageParts: MessageImagePart[] = [],
): Promise<void> {
	const channelId = message.channelId;
	const guildId = message.guild?.id;
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
		// Directory doesn't exist or isn't accessible — use default
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

	// Resolve the target channel we'll be posting in.
	const channel = message.channel;
	if (!('send' in channel)) return;
	const sendableChannel = channel as TextChannel | ThreadChannel;

	// ── UX model ──────────────────────────────────────────────────────────
	// The main channel carries Derek's conversation: his text responses and
	// the final result. It is NOT a play-by-play of tool calls.
	//
	// A single editable StatusLine at the bottom of the channel reflects
	// whatever is currently happening ("🔄 Thinking…", "🔄 read_file foo.ts").
	// It is deleted at end of run; a durable "✅ Done" marker is posted
	// separately so channel history retains a turn boundary.
	//
	// Threads are NOT created by default. A queue-prompt UI will (in a
	// follow-up step) offer the user a choice to fork current or queued
	// work into a thread when messages pile up mid-run.
	//
	// Errors are NOT surfaced with dedicated error messages in the main
	// channel unless they're fatal — we trust Derek to describe them in
	// his follow-up text response.
	// ──────────────────────────────────────────────────────────────────────

	const statusLine = new StatusLine(sendableChannel);
	await statusLine.update('🔄 Thinking…');

	// Track whether the model is currently generating text (so we can swap
	// status between "Thinking…" and "Running <tool>…" accurately).
	let lastStatusPhase: 'thinking' | 'tool' | 'approval' = 'thinking';
	// Preserve any partial streamed text — only used in the error/cancel
	// path to give the user something to look at before the response is lost.
	let streamBuffer = '';

	const abortController = new AbortController();
	// Register so `/stop` in this channel can interrupt us. If another run
	// somehow registered (shouldn't happen — channelLocks serialises us), we
	// overwrite it; the older run won't be reachable via /stop but will still
	// finish on its own.
	activeRuns.set(channelId, abortController);

	try {
		const result = await runtime.processMessage(
			messages,
			userContent,
			session.mode,
			{
				onToken: (token: string) => {
					// We no longer stream tokens into the main channel — the final
					// response is posted in one shot as durable messages below.
					// Buffer anyway so /stop can show partial output.
					streamBuffer += token;
					// If a tool call just finished and the model is generating
					// the next chunk of reasoning, reflect that in the status.
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
				onToolStart: async (toolName, args) => {
					lastStatusPhase = 'tool';
					void statusLine.update(`🔄 ${formatToolStatus(toolName, args)}`);
				},
				onToolResult: async () => {
					// No-op for now. The status line will get overwritten by the
					// next onToken ("Thinking…") or onToolStart, and the detail
					// view (in a follow-up step) will be driven from here.
				},
			},
			abortController.signal,
			imageParts.length > 0 ? imageParts : undefined,
		);

		// Save updated messages and mark this message as processed BEFORE
		// any durable UI posts — if posting fails, at least history is saved.
		await messageStore.saveMessages(conversationId, result.messages);
		await discordSessionStore.updateSession(conversationId, {
			lastProcessedMessageId: message.id,
		});

		// Post the final response as durable message(s). Append-only: no edits.
		const response = result.response.trim() || '*(no response)*';
		const chunks = splitMessage(response);
		for (const chunk of chunks) {
			await sendableChannel.send(chunk).catch(() => {});
		}

		// Clear the transient status line and leave a durable turn-boundary
		// marker so channel history retains a "this turn ended" receipt.
		await statusLine.clear();
		const toolSuffix =
			result.toolCallCount > 0
				? ` · ${result.toolCallCount} tool call${result.toolCallCount === 1 ? '' : 's'}`
				: '';
		await sendableChannel.send(`✅ Done${toolSuffix}`).catch(() => {});
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		const wasCancelled =
			abortController.signal.aborted ||
			errorMsg.toLowerCase().includes('cancelled') ||
			errorMsg.toLowerCase().includes('aborted');

		// Clear the status line regardless — it's transient and belongs to
		// the aborted/failed run.
		await statusLine.clear();

		if (wasCancelled) {
			// User-initiated stop — render as an interrupt, not an error.
			// The in-flight user turn is intentionally NOT saved to history,
			// so the user can send a fresh message with corrected guidance.
			const buffered = streamBuffer.trim();
			const tail = buffered
				? `\n\n**Partial output before stop:**\n${truncate(buffered, 1500)}`
				: '';
			await sendableChannel
				.send(`⏹ Stopped. Send a new message with the correction.${tail}`)
				.catch(() => {});
		} else {
			// Genuine runtime error. Post as a durable message in the main
			// channel so the user sees it; details go into the thread if one
			// was opened.
			await sendableChannel
				.send(`❌ Error: ${truncate(errorMsg, 1900)}`)
				.catch(() => {});
		}
	} finally {
		// Release the /stop hook only if we're still the registered controller —
		// avoids racing with a subsequent run that replaced us.
		if (activeRuns.get(channelId) === abortController) {
			activeRuns.delete(channelId);
		}
		// Restore previous working directory
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

			await interaction.editReply(
				`⏳ Summarising ${messages.length} messages...`,
			);

			const result = await autoCompact(messages, client);
			if (!result.compacted) {
				await interaction.editReply(
					`ℹ️ Context is ${messages.length} messages — nothing to compact yet (threshold: 40).`,
				);
				return;
			}

			await messageStore.saveMessages(conversationId, result.messages);
			await interaction.editReply(
				`📦 Compacted ${result.originalCount} → ${result.messages.length} messages using LLM summary.`,
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
			const controller = activeRuns.get(channelId);
			if (!controller) {
				await interaction.reply({
					content: 'Nothing running in this channel right now.',
					ephemeral: true,
				});
				return;
			}
			controller.abort();
			// We don't delete from activeRuns here — processUserMessage's
			// finally block will clean up once the abort propagates.
			await interaction.reply(
				'⏹ Stopping current run. Send a new message with the correction.',
			);
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

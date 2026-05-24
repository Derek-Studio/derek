import {createLLMClient} from '@/client-factory';
import {getAppConfig} from '@/config/index';
import {
	processToolUse,
	setToolManagerGetter,
	setToolRegistryGetter,
} from '@/message-handler';
import {parseToolCalls} from '@/tool-calling/index';
import {ToolManager} from '@/tools/tool-manager';
import type {
	DevelopmentMode,
	LLMClient,
	Message,
	ModeOverrides,
	ToolCall,
	ToolResult,
} from '@/types/core';
import {buildSystemPrompt} from '@/utils/prompt-builder';
import {parseToolArguments} from '@/utils/tool-args-parser';
import {getCurrentTaskId} from '../tasks/task-invocation-context.js';
import {taskStore} from '../tasks/task-store.js';
import {withToolCwd} from '../tasks/tool-cwd-context.js';
import type {DiscordDevelopmentMode} from '../types.js';

/**
 * Default per-call cap on conversation turns. A "turn" is one LLM
 * round-trip; one turn can issue many tool calls. Interactive flows use
 * this default. Task runs override it via `ProcessMessageOptions.maxTurns`
 * because long agentic chains (refactors, multi-file edits) routinely
 * burn 4-6 turns per file.
 */
const DEFAULT_MAX_TURNS = 25;

export interface RuntimeCallbacks {
	/** Called with streamed tokens. */
	onToken: (token: string) => void;
	/** Called when a tool needs user approval. Return the decision. */
	onToolApproval: (
		toolCall: ToolCall,
	) => Promise<'approve' | 'reject' | 'approve_all'>;
	/** Called when a tool starts executing. */
	onToolStart: (toolName: string, args: Record<string, unknown>) => void;
	/** Called when a tool finishes executing. */
	onToolResult: (toolName: string, result: string, isError: boolean) => void;
}

export interface ProcessMessageResult {
	/** The final assistant text response. */
	response: string;
	/** Messages after processing (includes all tool results). */
	messages: Message[];
	/** Total tool calls executed this turn. */
	toolCallCount: number;
}

export interface ProcessMessageOptions {
	/**
	 * Tool names to exclude from the available toolset for this call only.
	 * Used by tasks to hide task-management tools (no sub-tasks) and by
	 * the main channel to hide `task_checklist` (only meaningful inside
	 * a task).
	 */
	excludeTools?: string[];
	/**
	 * If set, skip the user-message append. Used by `task_continue` where
	 * the new prompt has already been added to history elsewhere.
	 */
	skipUserMessage?: boolean;
	/**
	 * Per-call cap on conversation turns. Defaults to `DEFAULT_MAX_TURNS`
	 * (25) for interactive / main-channel use. Task runs pass a larger
	 * value (e.g. 250) because long agentic chains can burn many turns
	 * per file edited.
	 */
	maxTurns?: number;
	/**
	 * Working directory to resolve tool paths and subprocess spawns
	 * against for this call. Propagated via AsyncLocalStorage so every
	 * path-resolving tool and every subprocess sees it without
	 * threading it through every signature. Defaults to `process.cwd()`
	 * when omitted (CLI / tests / any non-Discord caller).
	 */
	cwd?: string;
}

/**
 * Headless runtime for Derek — runs the conversation loop without React/Ink.
 *
 * Designed to be used by the Discord adapter (or any non-terminal interface).
 * Reuses Derek's existing ToolManager, AISDKClient, and prompt builder.
 */
export class HeadlessRuntime {
	private client: LLMClient | null = null;
	private toolManager: ToolManager | null = null;
	private actualProvider: string = '';
	private initialized = false;

	async initialize(provider?: string, model?: string): Promise<void> {
		if (this.initialized) return;

		// Create tool manager (same as App does)
		this.toolManager = new ToolManager();

		// Wire up the global tool registry getters (required by processToolUse)
		setToolRegistryGetter(() => this.toolManager?.getToolRegistry() ?? {});
		setToolManagerGetter(() => this.toolManager);

		// Create LLM client
		const {client, actualProvider} = await createLLMClient(provider, model);
		this.client = client;
		this.actualProvider = actualProvider;

		// Initialize MCP servers if configured
		const config = getAppConfig();
		if (config.mcpServers && config.mcpServers.length > 0) {
			try {
				await this.toolManager.initializeMCP(config.mcpServers);
			} catch (error) {
				console.error('Failed to initialize MCP servers:', error);
			}
		}

		this.initialized = true;
	}

	getClient(): LLMClient | null {
		return this.client;
	}

	getToolManager(): ToolManager | null {
		return this.toolManager;
	}

	/**
	 * Register additional Discord-only tools (e.g. task_start) into the
	 * runtime's ToolManager. Must be called after `initialize()`.
	 */
	registerToolExports(
		toolExports: Array<import('@/types/core').NanocoderToolExport>,
	): void {
		if (!this.toolManager) {
			throw new Error('Runtime not initialized. Call initialize() first.');
		}
		this.toolManager.registerToolExports(toolExports);
	}

	getProvider(): string {
		return this.actualProvider;
	}

	getModel(): string {
		return this.client?.getCurrentModel() ?? '';
	}

	setModel(model: string): void {
		this.client?.setModel(model);
	}

	/**
	 * Retry an async operation with exponential backoff.
	 * Skips retry for permanent errors (auth, bad request, cancellation).
	 */
	private async withRetry<T>(
		fn: () => Promise<T>,
		signal?: AbortSignal,
		maxAttempts = 4,
		baseDelayMs = 5000,
	): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (signal?.aborted) throw new Error('Operation was cancelled');
			try {
				return await fn();
			} catch (error) {
				lastError = error;
				if (error instanceof Error) {
					const msg = error.message.toLowerCase();
					if (
						msg.includes('cancelled') ||
						msg.includes('authentication') ||
						msg.includes('access forbidden') ||
						msg.includes('bad request') ||
						msg.includes('model not found')
					) {
						throw error;
					}
				}
				if (attempt < maxAttempts - 1) {
					const delay =
						baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
					console.warn(
						`LLM call failed (attempt ${attempt + 1}/${maxAttempts}): ${error instanceof Error ? error.message : String(error)}`,
					);
					console.warn(`Retrying in ${Math.round(delay / 1000)}s...`);
					await new Promise<void>(resolve => setTimeout(resolve, delay));
				}
			}
		}
		throw lastError;
	}

	/**
	 * Process a user message through the full conversation loop.
	 *
	 * This is the core agentic loop: send message → get response → if tool calls,
	 * execute them (with approval if needed) → send results back → repeat until
	 * the model responds with just text.
	 */
	async processMessage(
		messages: Message[],
		userContent: string,
		mode: DiscordDevelopmentMode,
		callbacks: RuntimeCallbacks,
		signal?: AbortSignal,
		imageParts?: import('@/types/core').MessageImagePart[],
		options?: ProcessMessageOptions,
	): Promise<ProcessMessageResult> {
		if (!this.client || !this.toolManager) {
			throw new Error('Runtime not initialized. Call initialize() first.');
		}

		// Establish the per-call tool cwd. Every tool invocation inside
		// this conversation loop — and every subprocess those tools spawn
		// — will resolve against this directory via AsyncLocalStorage.
		return await withToolCwd(options?.cwd ?? process.cwd(), () =>
			this.processMessageInner(
				messages,
				userContent,
				mode,
				callbacks,
				signal,
				imageParts,
				options,
			),
		);
	}

	private async processMessageInner(
		messages: Message[],
		userContent: string,
		mode: DiscordDevelopmentMode,
		callbacks: RuntimeCallbacks,
		signal?: AbortSignal,
		imageParts?: import('@/types/core').MessageImagePart[],
		options?: ProcessMessageOptions,
	): Promise<ProcessMessageResult> {
		if (!this.client || !this.toolManager) {
			throw new Error('Runtime not initialized. Call initialize() first.');
		}

		const client = this.client;

		// Append user message (unless caller prepared history themselves)
		if (!options?.skipUserMessage) {
			const userMessage: Message = {
				role: 'user',
				content: userContent,
				...(imageParts?.length ? {imageParts} : {}),
			};
			messages.push(userMessage);
		}

		// Build system prompt
		const devMode = mode as DevelopmentMode;
		let availableToolNames = this.toolManager.getAvailableToolNames(
			undefined,
			devMode,
		);
		if (options?.excludeTools?.length) {
			const excludeSet = new Set(options.excludeTools);
			availableToolNames = availableToolNames.filter(n => !excludeSet.has(n));
		}
		const systemPrompt = buildSystemPrompt(
			devMode,
			undefined,
			availableToolNames,
		);
		const systemMessage: Message = {role: 'system', content: systemPrompt};

		// Get tools (without execute — we handle execution ourselves)
		const alwaysAllow =
			mode === 'auto-accept' || mode === 'yolo'
				? availableToolNames
				: (getAppConfig().alwaysAllow ?? []);
		const tools = this.toolManager.getEffectiveTools(availableToolNames, {
			nonInteractiveAlwaysAllow: alwaysAllow,
		});

		let totalToolCalls = 0;
		let finalResponse = '';
		let approveAll = mode === 'yolo';

		const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
		// Per-loop counters for the finalisation guards. We allow a small
		// number of "almost done" nudges before giving up and finalising,
		// so a misbehaving model can't trap the loop forever.
		const MAX_FINALISATION_NUDGES = 3;
		let finalisationNudges = 0;

		// Conversation loop
		for (let turn = 0; turn < maxTurns; turn++) {
			if (signal?.aborted) throw new Error('Operation was cancelled');

			// Call LLM
			let _streamedContent = '';
			const modeOverrides: ModeOverrides = {
				nonInteractiveMode: mode !== 'normal' || approveAll,
				nonInteractiveAlwaysAllow: approveAll
					? availableToolNames
					: alwaysAllow,
			};

			const result = await this.withRetry(
				() =>
					client.chat(
						[systemMessage, ...messages],
						tools,
						{
							onToken: (token: string) => {
								_streamedContent += token;
								callbacks.onToken(token);
							},
						},
						signal,
						modeOverrides,
					),
				signal,
			);

			// Abort may have fired while the stream was already buffered — check
			// before we process or post the response.
			if (signal?.aborted) throw new Error('Operation was cancelled');

			if (!result?.choices?.[0]) {
				const dump = result
					? JSON.stringify(result, null, 2).slice(0, 800)
					: 'null';
				throw new Error(
					`No response from model — choices[0] missing.\nRaw result: ${dump}`,
				);
			}

			const message = result.choices[0].message;
			const content = message.content || '';
			const toolCalls = message.tool_calls || [];

			// Parse XML tool calls if tools were disabled (non-tool-calling model)
			let effectiveToolCalls = [...toolCalls];
			let cleanContent = content;

			if (result.toolsDisabled && content) {
				const parsed = parseToolCalls(content);
				if (parsed.success) {
					effectiveToolCalls.push(...parsed.toolCalls);
					cleanContent = parsed.cleanedContent;
				}
			}

			// Add assistant message to history. Push even on empty content so
			// the history reflects what the model actually returned — the
			// finalisation guards below depend on accurate accounting.
			const assistantMsg: Message = {
				role: 'assistant',
				content: cleanContent,
				tool_calls:
					effectiveToolCalls.length > 0 ? effectiveToolCalls : undefined,
			};
			messages.push(assistantMsg);

			// No tool calls = the model thinks it's done. Two guards before
			// we agree:
			//
			// 1. Empty-text guard (universal). If the response has no tool
			//    calls AND no text at all, that's almost always a streaming
			//    hiccup or a malformed tool call — never a real answer.
			//    Nudge the model to either commit to an answer or call the
			//    next tool.
			//
			// 2. Open-checklist guard (tasks only). If we're inside a task
			//    and the task's `task_checklist` still has pending/doing
			//    items, the model is finalising prematurely. Nudge it to
			//    update the checklist or continue working.
			//
			// Both guards re-prompt by appending a user message and
			// `continue`-ing the loop, capped at MAX_FINALISATION_NUDGES
			// total so a misbehaving model can't trap the loop forever.
			// NOTE: Must use role:'user' not role:'system' — Anthropic rejects
			// system messages that appear after user/assistant turns.
			if (effectiveToolCalls.length === 0) {
				const text = cleanContent.trim();

				if (text.length === 0 && finalisationNudges < MAX_FINALISATION_NUDGES) {
					finalisationNudges++;
					messages.push({
						role: 'user',
						content:
							'You returned no tool calls and no text. ' +
							'If your work is complete, respond with the final answer. ' +
							'Otherwise continue with the next tool call.',
					});
					continue;
				}

				const taskId = getCurrentTaskId();
				if (taskId && finalisationNudges < MAX_FINALISATION_NUDGES) {
					const task = taskStore.get(taskId);
					const open =
						task?.checklist.filter(
							i => i.state === 'pending' || i.state === 'doing',
						) ?? [];

					if (open.length > 0) {
						finalisationNudges++;
						const labels = open
							.map(i => `- ${i.label} (${i.state})`)
							.join('\n');
						messages.push({
							role: 'user',
							content:
								`You appear to be ending the task, but your checklist still has ${open.length} unfinished item(s):\n${labels}\n\n` +
								'If those items are actually done, call task_checklist to update their state to "done" or "skipped" and then respond with your final summary. ' +
								'If they are not done, continue with the next tool call.',
						});
						continue;
					}
				}

				finalResponse = cleanContent;
				break;
			}

			// Execute tool calls
			const toolResults: ToolResult[] = [];

			for (const tc of effectiveToolCalls) {
				if (signal?.aborted) throw new Error('Operation was cancelled');

				const toolName = tc.function.name;
				const toolArgs = parseToolArguments(tc.function.arguments);

				// Check if this tool needs approval
				let needsApproval = false;
				if (!approveAll && mode === 'normal') {
					needsApproval = this.checkNeedsApproval(tc);
				}

				if (needsApproval) {
					const decision = await callbacks.onToolApproval(tc);
					if (decision === 'reject') {
						toolResults.push({
							tool_call_id: tc.id,
							role: 'tool',
							name: toolName,
							content: 'Tool execution was rejected by the user.',
						});
						continue;
					}
					if (decision === 'approve_all') {
						approveAll = true;
					}
				}

				// Execute the tool
				callbacks.onToolStart(toolName, toolArgs as Record<string, unknown>);
				totalToolCalls++;

				try {
					const result = await processToolUse(tc);
					const isError = result.content.startsWith('Error: ');
					callbacks.onToolResult(toolName, result.content, isError);
					toolResults.push(result);
				} catch (error) {
					const errorContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
					callbacks.onToolResult(toolName, errorContent, true);
					toolResults.push({
						tool_call_id: tc.id,
						role: 'tool',
						name: toolName,
						content: errorContent,
					});
				}
			}

			// Add tool results to messages
			messages.push(...toolResults);

			if (signal?.aborted) throw new Error('Operation was cancelled');

			// If the model produced text AND tool calls, capture the text
			// (the final response will be whatever comes after the last tool loop)
			if (cleanContent.trim() && turn === maxTurns - 1) {
				finalResponse = cleanContent;
			}
		}

		return {
			response: finalResponse,
			messages,
			toolCallCount: totalToolCalls,
		};
	}

	/**
	 * Check if a tool call needs user approval based on its needsApproval property.
	 */
	private checkNeedsApproval(tc: ToolCall): boolean {
		if (!this.toolManager) return true;

		const entry = this.toolManager.getToolEntry(tc.function.name);
		if (!entry?.tool) return true;

		const needsApprovalProp = (
			entry.tool as unknown as {
				needsApproval?:
					| boolean
					| ((args: unknown) => boolean | Promise<boolean>);
			}
		).needsApproval;

		if (typeof needsApprovalProp === 'boolean') {
			return needsApprovalProp;
		}

		// For function-based needsApproval, default to true (safer)
		// since we can't easily await in the sync check path
		return true;
	}
}

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
import type {DiscordDevelopmentMode} from '../types.js';

const MAX_TURNS = 25;

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
	): Promise<ProcessMessageResult> {
		if (!this.client || !this.toolManager) {
			throw new Error('Runtime not initialized. Call initialize() first.');
		}

		const client = this.client;

		// Append user message
		const userMessage: Message = {role: 'user', content: userContent};
		messages.push(userMessage);

		// Build system prompt
		const devMode = mode as DevelopmentMode;
		const availableToolNames = this.toolManager.getAvailableToolNames(
			undefined,
			devMode,
		);
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

		// Conversation loop
		for (let turn = 0; turn < MAX_TURNS; turn++) {
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

			// Add assistant message to history
			const assistantMsg: Message = {
				role: 'assistant',
				content: cleanContent,
				tool_calls:
					effectiveToolCalls.length > 0 ? effectiveToolCalls : undefined,
			};

			if (cleanContent.trim() || effectiveToolCalls.length > 0) {
				messages.push(assistantMsg);
			}

			// No tool calls = conversation complete
			if (effectiveToolCalls.length === 0) {
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

			// If the model produced text AND tool calls, capture the text
			// (the final response will be whatever comes after the last tool loop)
			if (cleanContent.trim() && turn === MAX_TURNS - 1) {
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

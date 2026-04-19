import {randomBytes} from 'node:crypto';
import type {ToolCall} from '@/types/index';

/**
 * Generates a unique tool call ID
 */
export function generateToolCallId(): string {
	return `tool_${Date.now()}_${randomBytes(8).toString('hex')}`;
}

/**
 * Converts AI SDK tool call format to our ToolCall format
 */
export function convertAISDKToolCall(toolCall: {
	toolCallId?: string;
	toolName: string;
	input: unknown;
}): ToolCall {
	return {
		id: toolCall.toolCallId || generateToolCallId(),
		function: {
			name: toolCall.toolName,
			arguments: toolCall.input as Record<string, unknown>,
		},
	};
}

/**
 * Converts multiple AI SDK tool calls to our ToolCall format
 */
export function convertAISDKToolCalls(
	toolCalls: Array<{
		toolCallId?: string;
		toolName: string;
		input: unknown;
	}>,
): ToolCall[] {
	return toolCalls.map(convertAISDKToolCall);
}

/**
 * Gets the tool result output as a string
 */
export function getToolResultOutput(output: unknown): string {
	return typeof output === 'string' ? output : JSON.stringify(output);
}

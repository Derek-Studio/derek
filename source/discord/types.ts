export interface DiscordConfig {
	botToken: string;
	applicationId: string;
	guildIds: string[];
	allowedChannelIds: string[];
	workingDirectory: string;
	/**
	 * Directory containing project folders. Channels whose names match a
	 * subfolder will automatically use that folder as their working directory.
	 * Falls back to `workingDirectory` for unmatched channels.
	 */
	projectsDirectory: string;
	/**
	 * Explicit channel ID → working directory overrides.
	 * Takes priority over automatic project-name matching.
	 */
	channelProjectMapping: Record<string, string>;
}

export interface DiscordSessionData {
	sessionId: string;
	channelId: string;
	guildId?: string;
	conversationId: string;
	workingDirectory: string;
	model?: string;
	provider?: string;
	mode: DiscordDevelopmentMode;
	createdAt: string;
	lastActiveAt: string;
	lastProcessedMessageId?: string;
}

export type DiscordDevelopmentMode = 'normal' | 'auto-accept' | 'yolo';

export interface DiscordMessage {
	channelId: string;
	guildId?: string;
	messageId: string;
	userId: string;
	username: string;
	content: string;
	attachments: DiscordAttachment[];
	isThread: boolean;
	threadId?: string;
}

export interface DiscordAttachment {
	name: string;
	url: string;
	contentType?: string;
	size: number;
}

export interface StreamingState {
	messageId: string | null;
	content: string;
	lastEditTime: number;
	isComplete: boolean;
}

export interface ToolApprovalRequest {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	messageId?: string;
	resolve: (decision: 'approve' | 'reject' | 'approve_all') => void;
}

export interface ProgressThread {
	threadId: string;
	progressMessageId: string;
	steps: ProgressStep[];
	title: string;
	isComplete: boolean;
}

export interface ProgressStep {
	label: string;
	status: 'pending' | 'running' | 'complete' | 'error';
	detail?: string;
}

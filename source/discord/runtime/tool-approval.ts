import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type DMChannel,
	type TextChannel,
	type ThreadChannel,
} from 'discord.js';
import type {ToolCall} from '@/types/core';
import {formatToolApproval} from '../ui/message-formatter.js';

type DiscordChannel = TextChannel | ThreadChannel | DMChannel;

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Post a tool approval request as a Discord message with buttons.
 * Returns the user's decision.
 */
export async function requestToolApproval(
	channel: DiscordChannel,
	toolCall: ToolCall,
): Promise<'approve' | 'reject' | 'approve_all'> {
	const content = formatToolApproval(toolCall);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`tool_approve_${toolCall.id}`)
			.setLabel('✅ Approve')
			.setStyle(ButtonStyle.Success),
		new ButtonBuilder()
			.setCustomId(`tool_reject_${toolCall.id}`)
			.setLabel('❌ Reject')
			.setStyle(ButtonStyle.Danger),
		new ButtonBuilder()
			.setCustomId(`tool_approve_all_${toolCall.id}`)
			.setLabel('✅ Approve All')
			.setStyle(ButtonStyle.Primary),
	);

	const msg = await channel.send({
		content,
		components: [row],
	});

	try {
		const interaction = await msg.awaitMessageComponent({
			time: APPROVAL_TIMEOUT_MS,
		});

		// Acknowledge the interaction
		await interaction.update({
			content: `${content}\n\n→ **${interaction.customId.includes('reject') ? 'Rejected' : 'Approved'}** by ${interaction.user.username}`,
			components: [], // Remove buttons
		});

		if (interaction.customId.startsWith('tool_approve_all_')) {
			return 'approve_all';
		}
		if (interaction.customId.startsWith('tool_reject_')) {
			return 'reject';
		}
		return 'approve';
	} catch {
		// Timeout — auto-reject
		await msg
			.edit({
				content: `${content}\n\n→ **Auto-rejected** (timed out after 5 minutes)`,
				components: [],
			})
			.catch(() => {});

		return 'reject';
	}
}

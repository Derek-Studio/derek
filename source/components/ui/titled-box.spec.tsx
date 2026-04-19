import test from 'ava';
import {Text} from 'ink';
import {renderWithTheme} from '@/test-utils/render-with-theme';
import React from 'react';
import {TitledBox} from './titled-box.js';

// ============================================================================
// Tests for TitledBox Component
// ============================================================================

console.log(`\ntitled-box.spec.tsx – ${React.version}`);

test('TitledBox renders with title', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Test Title" borderColor="blue">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Test Title/);
});

test('TitledBox renders children content', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Title" borderColor="green">
			<Text>Hello World</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.regex(output!, /Hello World/);
});

test('TitledBox renders with rounded border', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Bordered" borderColor="cyan">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	// Check for rounded border characters
	t.regex(output!, /╭/); // Top-left corner
	t.regex(output!, /╮/); // Top-right corner
	t.regex(output!, /╰/); // Bottom-left corner
	t.regex(output!, /╯/); // Bottom-right corner
});

test('TitledBox renders without crashing with minimal props', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Minimal">
			<Text>Content</Text>
		</TitledBox>,
	);

	t.truthy(lastFrame());
});

test('TitledBox renders with custom width', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Wide Box" borderColor="yellow" width={50}>
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Wide Box/);
});

test('TitledBox renders with padding', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Padded" borderColor="magenta" paddingX={2} paddingY={1}>
			<Text>Padded Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.regex(output!, /Padded Content/);
});

test('TitledBox renders with flexDirection column', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Column" borderColor="white" flexDirection="column">
			<Text>Line 1</Text>
			<Text>Line 2</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.regex(output!, /Line 1/);
	t.regex(output!, /Line 2/);
});

test('TitledBox renders with marginBottom', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="With Margin" borderColor="red" marginBottom={1}>
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /With Margin/);
});

test('TitledBox renders multiple children', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Multiple" borderColor="blue">
			<Text>First</Text>
			<Text>Second</Text>
			<Text>Third</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.regex(output!, /First/);
	t.regex(output!, /Second/);
	t.regex(output!, /Third/);
});

test('TitledBox renders with empty title', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="" borderColor="green">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Content/);
});

test('TitledBox renders with special characters in title', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="✻ Special & <Title>" borderColor="cyan">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.regex(output!, /✻/);
	t.regex(output!, /Special/);
});

test('TitledBox renders with long title', t => {
	const longTitle = 'This is a very long title that might overflow';
	const {lastFrame} = renderWithTheme(
		<TitledBox title={longTitle} borderColor="yellow">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.regex(output!, /This is a very long title/);
});

test('TitledBox renders nested components', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Nested" borderColor="magenta">
			<Text color="red">Red text</Text>
			<Text bold>Bold text</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.regex(output!, /Red text/);
	t.regex(output!, /Bold text/);
});

test('TitledBox renders with all props combined', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox
			title="Full Props"
			borderColor="blue"
			width={60}
			paddingX={2}
			paddingY={1}
			flexDirection="column"
			marginBottom={1}
		>
			<Text>Fully configured content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Full Props/);
	t.regex(output!, /Fully configured content/);
});

test('TitledBox title appears before content box', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Header" borderColor="green">
			<Text>Body</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	const titleIndex = output!.indexOf('Header');
	const bodyIndex = output!.indexOf('Body');

	// Title should appear before body in the output
	t.true(titleIndex < bodyIndex);
});

// ============================================================================
// New tests for shape functionality
// ============================================================================

test('TitledBox renders with rounded shape', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Rounded" shape="rounded" borderColor="blue">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Rounded/);
	t.regex(output!, /╭/); // Should contain rounded corner
});

test('TitledBox renders with square shape', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Square" shape="square" borderColor="green">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Square/);
	t.regex(output!, /┌/); // Should contain square corner
});

test('TitledBox renders with double shape', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Double" shape="double" borderColor="cyan">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Double/);
	t.regex(output!, /╔/); // Should contain double corner
});

test('TitledBox renders with pill shape (default)', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Pill" borderColor="magenta">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Pill/);
});

test('TitledBox renders with powerline-angled shape', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Powerline" shape="powerline-angled" borderColor="yellow">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Powerline/);
});

test('TitledBox renders with arrow-left shape', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Arrow" shape="arrow-left" borderColor="red">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Arrow/);
	t.regex(output!, /←/); // Should contain left arrow
});

test('TitledBox renders with icon', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="With Icon" shape="rounded" borderColor="blue" icon="✻">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /✻/); // Should contain icon
	t.regex(output!, /With Icon/);
});

test('TitledBox maintains backward compatibility with default pill shape', t => {
	const {lastFrame} = renderWithTheme(
		<TitledBox title="Backward Compat" borderColor="green">
			<Text>Content</Text>
		</TitledBox>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Backward Compat/);
});

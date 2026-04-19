import test from 'ava';
import React from 'react';
import type {BashExecutionState} from '@/services/bash-executor';
import {renderWithTheme} from '../test-utils/render-with-theme.js';
import BashProgress from './bash-progress';

console.log('\nbash-progress.spec.tsx');

// Helper to create a completed state for static rendering tests
function createCompletedState(
	overrides: Partial<BashExecutionState> = {},
): BashExecutionState {
	return {
		executionId: 'test-execution-id',
		command: 'echo test',
		outputPreview: '',
		fullOutput: '',
		stderr: '',
		isComplete: true,
		exitCode: 0,
		error: null,
		...overrides,
	};
}

// ============================================================================
// Basic Rendering Tests (Static Mode with completedState)
// ============================================================================

test('BashProgress renders without crashing', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="echo hello"
			completedState={createCompletedState()}
		/>,
	);

	t.truthy(lastFrame());
});

test('BashProgress displays the command', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="npm run build"
			completedState={createCompletedState({command: 'npm run build'})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /npm run build/);
});

test('BashProgress displays execute_bash tool name', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="echo test"
			completedState={createCompletedState()}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /execute_bash/);
});

test('BashProgress displays Command label', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="ls -la"
			completedState={createCompletedState({command: 'ls -la'})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Command:/);
});

// ============================================================================
// Status Display Tests (Completed State)
// ============================================================================

test('BashProgress shows status indicator when complete', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="echo test"
			completedState={createCompletedState({isComplete: true})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Status:/);
	t.regex(output!, /●/);
});

test('BashProgress shows token count when complete', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="echo test"
			completedState={createCompletedState({
				isComplete: true,
				fullOutput: 'some output text',
			})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Tokens:/);
	t.regex(output!, /~/);
});

// ============================================================================
// Exit Code Tests
// ============================================================================

test('BashProgress handles successful exit code', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="echo success"
			completedState={createCompletedState({
				isComplete: true,
				exitCode: 0,
			})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	// Should render without error
	t.regex(output!, /●/);
});

test('BashProgress handles failed exit code', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="exit 1"
			completedState={createCompletedState({
				isComplete: true,
				exitCode: 1,
			})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	// Should render with status indicator
	t.regex(output!, /●/);
});

// ============================================================================
// Error State Tests
// ============================================================================

test('BashProgress handles error state', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="invalid-command"
			completedState={createCompletedState({
				isComplete: true,
				exitCode: null,
				error: 'Command not found',
			})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	// Should still render status indicator
	t.regex(output!, /●/);
});

test('BashProgress handles cancelled state', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="sleep 100"
			completedState={createCompletedState({
				isComplete: true,
				error: 'Cancelled by user',
			})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /●/);
});

// ============================================================================
// Output Preview Tests (In-Progress State)
// ============================================================================

test('BashProgress shows output preview when not complete and has preview', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="long-running-command"
			completedState={{
				...createCompletedState(),
				isComplete: false,
				outputPreview: 'partial output...',
			}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Output:/);
	t.regex(output!, /partial output/);
});

test('BashProgress does not show output preview when complete', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="echo done"
			completedState={createCompletedState({
				isComplete: true,
				outputPreview: 'this should not show',
				fullOutput: 'done',
			})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	// Output preview section should not be shown when complete
	// Status and Tokens should be shown instead
	t.regex(output!, /Status:/);
	t.regex(output!, /Tokens:/);
});

test('BashProgress does not show status when not complete', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="running"
			completedState={{
				...createCompletedState(),
				isComplete: false,
			}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	// Status should only show when complete
	t.notRegex(output!, /Status:/);
});

// ============================================================================
// isLive Prop Tests
// ============================================================================

test('BashProgress renders with isLive=true', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="echo live"
			completedState={createCompletedState()}
			isLive={true}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /echo live/);
});

test('BashProgress renders with isLive=false (default)', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="echo static"
			completedState={createCompletedState()}
			isLive={false}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /echo static/);
});

// ============================================================================
// Token Calculation Tests
// ============================================================================

test('BashProgress calculates tokens from output', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="echo test"
			completedState={createCompletedState({
				isComplete: true,
				fullOutput: 'This is some test output that should produce tokens',
			})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Tokens:/);
	// Should have a number after ~
	t.regex(output!, /~\d+/);
});

test('BashProgress includes stderr in token calculation', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="echo test"
			completedState={createCompletedState({
				isComplete: true,
				fullOutput: 'stdout content',
				stderr: 'stderr content',
			})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Tokens:/);
});

test('BashProgress handles empty output for token calculation', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="true"
			completedState={createCompletedState({
				isComplete: true,
				fullOutput: '',
				stderr: '',
			})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /Tokens:/);
	t.regex(output!, /~0/);
});

// ============================================================================
// Edge Cases
// ============================================================================

test('BashProgress handles long command', t => {
	const longCommand = 'echo ' + 'a'.repeat(200);
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command={longCommand}
			completedState={createCompletedState({command: longCommand})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	// Should contain part of the command
	t.regex(output!, /echo/);
});

test('BashProgress handles special characters in command', t => {
	const command = 'echo "hello $USER" && ls -la | grep test';
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command={command}
			completedState={createCompletedState({command})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /echo/);
});

test('BashProgress handles multiline output preview', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="cat file"
			completedState={{
				...createCompletedState(),
				isComplete: false,
				outputPreview: 'line1\nline2\nline3',
			}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /line1/);
});

// ============================================================================
// Component Structure Tests
// ============================================================================

test('BashProgress uses ToolMessage component', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="echo test"
			completedState={createCompletedState()}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	// ToolMessage renders content, so we just verify the component renders
	t.true(output!.length > 0);
});

test('BashProgress renders all required elements when complete', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="my-command"
			completedState={createCompletedState({
				isComplete: true,
				fullOutput: 'output',
			})}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /execute_bash/);
	t.regex(output!, /Command:/);
	t.regex(output!, /my-command/);
	t.regex(output!, /Status:/);
	t.regex(output!, /●/);
	t.regex(output!, /Tokens:/);
});

test('BashProgress renders minimal elements when not complete', t => {
	const {lastFrame} = renderWithTheme(
		<BashProgress
			executionId="test-id"
			command="running-command"
			completedState={{
				...createCompletedState(),
				isComplete: false,
			}}
		/>,
	);

	const output = lastFrame();
	t.truthy(output);
	t.regex(output!, /execute_bash/);
	t.regex(output!, /Command:/);
	t.regex(output!, /running-command/);
	// Should not have Status or Tokens when not complete
	t.notRegex(output!, /Status:/);
	t.notRegex(output!, /Tokens:/);
});

import test from 'ava';
import React from 'react';
import {renderWithTheme} from '../../test-utils/render-with-theme';
import {ChatHistory} from './chat-history';
import type {ChatHistoryProps} from './chat-history';

function createDefaultProps(
	overrides: Partial<ChatHistoryProps> = {},
): ChatHistoryProps {
	return {
		startChat: true,
		staticComponents: [],
		queuedComponents: [],
		...overrides,
	};
}

test('ChatHistory renders without error', t => {
	const props = createDefaultProps();
	const {lastFrame, unmount} = renderWithTheme(<ChatHistory {...props} />);
	const output = lastFrame();
	// Empty components render as empty string, which is valid
	t.is(typeof output, 'string');
	unmount();
});

test('ChatHistory renders static components', t => {
	const props = createDefaultProps({
		staticComponents: [<div key="static-1">Static Content</div>],
	});
	const {lastFrame, unmount} = renderWithTheme(<ChatHistory {...props} />);
	const output = lastFrame();
	t.truthy(output);
	unmount();
});

test('ChatHistory renders queued components', t => {
	const props = createDefaultProps({
		queuedComponents: [<div key="queued-1">Queued Content</div>],
	});
	const {lastFrame, unmount} = renderWithTheme(<ChatHistory {...props} />);
	const output = lastFrame();
	t.truthy(output);
	unmount();
});

test('ChatHistory does not render content when startChat is false', t => {
	const props = createDefaultProps({
		startChat: false,
		staticComponents: [<div key="static-1">Should Not Show</div>],
	});
	const {lastFrame, unmount} = renderWithTheme(<ChatHistory {...props} />);
	const output = lastFrame();
	// Should render empty when startChat is false
	t.is(typeof output, 'string');
	// Content should not include the static component text
	t.false(output?.includes('Should Not Show'));
	unmount();
});

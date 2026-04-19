import test from 'ava';
import {createResetStreamingState} from './streaming-state.js';

test('createResetStreamingState - resets all state', t => {
	let isCancelling = true;
	let abortController: AbortController | null = new AbortController();
	let isGenerating = true;
	let streamingContent = 'some content';
	let tokenCount = 100;

	const resetStreamingState = createResetStreamingState(
		(val: boolean) => { isCancelling = val; },
		(val: AbortController | null) => { abortController = val; },
		(val: boolean) => { isGenerating = val; },
		(val: string) => { streamingContent = val; },
		(val: number) => { tokenCount = val; },
	);

	resetStreamingState();

	t.is(isCancelling, false);
	t.is(abortController as AbortController | null, null);
	t.is(isGenerating, false);
	t.is(streamingContent, '');
	t.is(tokenCount, 0);
});

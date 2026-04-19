import test from 'ava';
import type {AppProps} from './types';

test('App types are properly exported', t => {
	const props: AppProps = {
		vscodeMode: false,
		nonInteractiveMode: false,
	};

	t.truthy(props);
	t.is(props.vscodeMode, false);
	t.is(props.nonInteractiveMode, false);
});

test('AppProps accepts all optional parameters', t => {
	const minimalProps: AppProps = {};
	const fullProps: AppProps = {
		vscodeMode: true,
		vscodePort: 3000,
		nonInteractivePrompt: 'test prompt',
		nonInteractiveMode: true,
	};

	t.truthy(minimalProps);
	t.truthy(fullProps);
	t.is(fullProps.vscodeMode, true);
	t.is(fullProps.vscodePort, 3000);
	t.is(fullProps.nonInteractivePrompt, 'test prompt');
	t.is(fullProps.nonInteractiveMode, true);
});

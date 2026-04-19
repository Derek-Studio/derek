import {ThemeContext, useTheme} from './useTheme.js';
import type {Colors, ThemePreset} from '../types/ui.js';
import test from 'ava';
import {render} from 'ink-testing-library';
import React, {useState} from 'react';

console.log('\nuseTheme.spec.ts');

// Helper component to test useTheme
function ThemeConsumer({
	onRender,
}: {
	onRender: (theme: ReturnType<typeof useTheme>) => void;
}) {
	const theme = useTheme();
	React.useEffect(() => {
		onRender(theme);
	}, [theme, onRender]);
	return null;
}

// Mock ThemeProvider for testing
function MockThemeProvider({
	children,
	initialTheme = 'default' as ThemePreset,
}: {
	children: React.ReactNode;
	initialTheme?: ThemePreset;
}) {
	const [currentTheme, setCurrentTheme] = useState<ThemePreset>(initialTheme);

	// Mock colors for testing
	const colors: Colors = {
		text: '#ffffff',
		base: '#000000',
		primary: '#ff0000',
		tool: '#00ff00',
		secondary: '#888888',
		error: '#ff0000',
		warning: '#ffaa00',
		success: '#00ff00',
		info: '#0000ff',
		diffAdded: '#00ff00',
		diffRemoved: '#ff0000',
		diffAddedText: '#000000',
		diffRemovedText: '#ffffff',
	};

	const value = {
		currentTheme,
		colors,
		setCurrentTheme,
	};

	return React.createElement(ThemeContext.Provider, {value}, children);
}

test('useTheme returns theme context when used within provider', t => {
	let capturedTheme: ReturnType<typeof useTheme> | null = null;

	render(
		React.createElement(MockThemeProvider, {
			initialTheme: 'dracula',
			children: React.createElement(ThemeConsumer, {
				onRender: theme => {
					capturedTheme = theme;
				},
			}),
		}),
	);

	t.truthy(capturedTheme);
	t.is(capturedTheme!.currentTheme, 'dracula');
	t.truthy(capturedTheme!.colors);
	t.is(typeof capturedTheme!.setCurrentTheme, 'function');
});

test('useTheme provides colors object', t => {
	let capturedTheme: ReturnType<typeof useTheme> | null = null;

	render(
		React.createElement(MockThemeProvider, {
			initialTheme: 'dracula',
			children: React.createElement(ThemeConsumer, {
				onRender: theme => {
					capturedTheme = theme;
				},
			}),
		}),
	);

	t.truthy(capturedTheme);
	const colors = capturedTheme!.colors;

	// Check all required color properties exist
	t.is(typeof colors.text, 'string');
	t.is(typeof colors.base, 'string');
	t.is(typeof colors.primary, 'string');
	t.is(typeof colors.tool, 'string');
	t.is(typeof colors.secondary, 'string');
	t.is(typeof colors.error, 'string');
	t.is(typeof colors.warning, 'string');
	t.is(typeof colors.success, 'string');
	t.is(typeof colors.info, 'string');
	t.is(typeof colors.diffAdded, 'string');
	t.is(typeof colors.diffRemoved, 'string');
	t.is(typeof colors.diffAddedText, 'string');
	t.is(typeof colors.diffRemovedText, 'string');
});

test('useTheme allows changing theme via setCurrentTheme', t => {
	let capturedTheme: ReturnType<typeof useTheme> | null = null;

	const {rerender} = render(
		React.createElement(MockThemeProvider, {
			initialTheme: 'dracula',
			children: React.createElement(ThemeConsumer, {
				onRender: theme => {
					capturedTheme = theme;
				},
			}),
		}),
	);

	t.is(capturedTheme!.currentTheme, 'dracula');

	// Change theme
	capturedTheme!.setCurrentTheme('tokyo-night');

	rerender(
		React.createElement(MockThemeProvider, {
			initialTheme: 'tokyo-night',
			children: React.createElement(ThemeConsumer, {
				onRender: theme => {
					capturedTheme = theme;
				},
			}),
		}),
	);

	t.is(capturedTheme!.currentTheme, 'tokyo-night');
});

test('useTheme works with different theme presets', t => {
	const themes: ThemePreset[] = [
		'dracula',
		'tokyo-night',
		'synthwave-84',
		'forest-night',
		'material-ocean',
		'sunset-glow',
	];

	for (const theme of themes) {
		let capturedTheme: ReturnType<typeof useTheme> | null = null;

		render(
			React.createElement(MockThemeProvider, {
				initialTheme: theme,
				children: React.createElement(ThemeConsumer, {
					onRender: themeArg => {
						capturedTheme = themeArg;
					},
				}),
			}),
		);

		t.truthy(capturedTheme);
		t.is(capturedTheme!.currentTheme, theme);
	}
});

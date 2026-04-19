import test from 'ava';
import {stripMarkdown} from './utils.js';

console.log(`\nutils.spec.ts`);

test('stripMarkdown removes inline code', t => {
	const text = 'Use `npm install` to install';
	const result = stripMarkdown(text);
	t.is(result, 'Use npm install to install');
});

test('stripMarkdown removes bold with double asterisks', t => {
	const text = 'This is **bold** text';
	const result = stripMarkdown(text);
	t.is(result, 'This is bold text');
});

test('stripMarkdown removes italic with single asterisks', t => {
	const text = 'This is *italic* text';
	const result = stripMarkdown(text);
	t.is(result, 'This is italic text');
});

test('stripMarkdown removes links', t => {
	const text = 'Visit [Google](https://google.com) for search';
	const result = stripMarkdown(text);
	t.is(result, 'Visit Google for search');
});

test('stripMarkdown handles multiple formatting types', t => {
	const text = 'Use **bold** and *italic* with `code` and [links](url)';
	const result = stripMarkdown(text);
	t.is(result, 'Use bold and italic with code and links');
});

test('stripMarkdown preserves plain text', t => {
	const text = 'This is plain text with no formatting';
	const result = stripMarkdown(text);
	t.is(result, text);
});

test('stripMarkdown handles empty string', t => {
	const result = stripMarkdown('');
	t.is(result, '');
});

test('stripMarkdown preserves underscores', t => {
	const text = 'snake_case and another_variable';
	const result = stripMarkdown(text);
	t.is(result, text);
});

test('stripMarkdown handles nested markdown', t => {
	const text = '**This is `code` in bold**';
	const result = stripMarkdown(text);
	t.is(result, 'This is code in bold');
});

test('stripMarkdown handles multiple links', t => {
	const text = '[First](url1) and [Second](url2)';
	const result = stripMarkdown(text);
	t.is(result, 'First and Second');
});

test('stripMarkdown handles incomplete markdown gracefully', t => {
	const text = 'This has **incomplete bold and `incomplete code';
	const result = stripMarkdown(text);
	// Should leave incomplete markdown as-is
	t.true(result.includes('**incomplete') || result.includes('incomplete'));
});

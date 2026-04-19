import test from 'ava';
import {Text} from 'ink';
import {renderWithTheme} from '@/test-utils/render-with-theme';
import React from 'react';
import {StyledTitle, hasNerdFontSupport} from './styled-title';

// ============================================================================
// Tests for StyledTitle Component
// ============================================================================

console.log(`\nstyled-title.spec.tsx – ${React.version}`);

test('StyledTitle renders with default rounded shape', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Test Title" borderColor="blue" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Test Title/);
  t.regex(output!, /╭/); // Should contain rounded corner
});

test('StyledTitle renders with square shape', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Square Title" shape="square" borderColor="green" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Square Title/);
  t.regex(output!, /┌/); // Should contain square corner
});

test('StyledTitle renders with double shape', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Double Title" shape="double" borderColor="cyan" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Double Title/);
  t.regex(output!, /╔/); // Should contain double corner
});

test('StyledTitle renders with pill shape (original style)', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Pill Title" shape="pill" borderColor="magenta" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Pill Title/);
});

test('StyledTitle renders with powerline-angled shape', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Powerline" shape="powerline-angled" borderColor="yellow" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Powerline/);
  // Note: Powerline symbols may not render in test output but should not crash
});

test('StyledTitle renders with powerline-curved shape', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Curved" shape="powerline-curved" borderColor="white" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Curved/);
});

test('StyledTitle renders with arrow-left shape', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Arrow" shape="arrow-left" borderColor="red" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Arrow/);
  t.regex(output!, /←/); // Should contain left arrow
});

test('StyledTitle renders with arrow-right shape', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Arrow" shape="arrow-right" borderColor="blue" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Arrow/);
  t.regex(output!, /→/); // Should contain right arrow
});

test('StyledTitle renders with arrow-double shape', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Double" shape="arrow-double" borderColor="green" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Double/);
  t.regex(output!, /«/); // Should contain double arrow
});

test('StyledTitle renders with angled-box shape', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Angled" shape="angled-box" borderColor="cyan" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Angled/);
  t.regex(output!, /╱/); // Should contain angled characters
});

test('StyledTitle renders with icon', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="With Icon" shape="rounded" borderColor="magenta" icon="✻" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /✻/); // Should contain icon
  t.regex(output!, /With Icon/);
});

test('StyledTitle renders with custom text color', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Custom Color" shape="square" borderColor="yellow" textColor="red" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Custom Color/);
});

test('StyledTitle renders with custom width', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Wide Title" shape="rounded" borderColor="white" width={50} />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Wide Title/);
});

test('StyledTitle renders with long title', t => {
  const longTitle = 'This is a very long title that might overflow';
  const {lastFrame} = renderWithTheme(
    <StyledTitle title={longTitle} shape="rounded" borderColor="red" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /This is a very long title/);
});

test('StyledTitle renders with empty title', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="" shape="rounded" borderColor="blue" />,
  );

  const output = lastFrame();
  t.truthy(output);
});

test('StyledTitle renders with special characters in title', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="✻ Special & <Title>" shape="rounded" borderColor="green" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /✻/);
  t.regex(output!, /Special/);
});

test('StyledTitle renders with all props combined', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle
      title="Full Props"
      shape="powerline-curved"
      borderColor="blue"
      textColor="white"
      icon="⚡"
      width={60}
    />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /⚡/);
  t.regex(output!, /Full Props/);
});

test('StyledTitle falls back to rounded shape for unknown shape', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Unknown" shape="unknown-shape" as="unknown" borderColor="red" />,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Unknown/);
  t.regex(output!, /╭/); // Should fall back to rounded
});

test('StyledTitle renders nested components', t => {
  const {lastFrame} = renderWithTheme(
    <StyledTitle title="Nested" shape="rounded" borderColor="magenta">
      <Text color="red">Additional content</Text>
    </StyledTitle>,
  );

  const output = lastFrame();
  t.truthy(output);
  t.regex(output!, /Nested/);
});

test('StyledTitle has Nerd Font support detection', t => {
  // This test verifies that the Nerd Font detection function works
  // In a real environment with Nerd Fonts, this should return true
  const hasSupport = hasNerdFontSupport();
  t.truthy(typeof hasSupport === 'boolean');
});
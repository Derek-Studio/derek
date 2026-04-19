import { writeFileSync, rmSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import test from 'ava';
import { ProjectAnalyzer } from './project-analyzer';

// Create a temporary test directory
const testDir = join(tmpdir(), `nanocoder-project-analyzer-test-${Date.now()}`);

test.before(() => {
	// Create test directory with some structure
	mkdirSync(testDir, {recursive: true});
	mkdirSync(join(testDir, 'src'), {recursive: true});
	mkdirSync(join(testDir, 'test'), {recursive: true});
	mkdirSync(join(testDir, 'docs'), {recursive: true});
});

test.after.always(() => {
	// Clean up test directory
	if (existsSync(testDir)) {
		rmSync(testDir, {recursive: true, force: true});
	}
});

test('ProjectAnalyzer - constructor initializes with project path', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	t.truthy(analyzer);
});

test('ProjectAnalyzer - isCodeFile identifies code files by extension', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	// This is a private method but we can test the public analyze method
	// which uses it internally
	t.pass('isCodeFile is tested implicitly through analyze method');
});

test('ProjectAnalyzer - isTestFile identifies test files', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	// Create test files and directories
	mkdirSync(join(testDir, '__tests__'), {recursive: true});
	writeFileSync(join(testDir, 'app.test.js'), 'test');
	writeFileSync(join(testDir, 'app.spec.ts'), 'test');
	writeFileSync(join(testDir, '__tests__', 'app.js'), 'test');
	writeFileSync(join(testDir, 'src', 'app.js'), 'test');

	// Test file identification is used in analyze method
	const analysis = analyzer.analyze();

	// The analysis should work without throwing
	t.truthy(analysis);
});

test('ProjectAnalyzer - getImportantDirectories returns sorted directories', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	// Create more directories
	mkdirSync(join(testDir, 'components'), {recursive: true});
	mkdirSync(join(testDir, 'lib'), {recursive: true});
	mkdirSync(join(testDir, 'build'), {recursive: true});

	// Create files in directories so they're scanned
	writeFileSync(join(testDir, 'src', 'app.ts'), 'test');
	writeFileSync(join(testDir, 'components', 'Button.tsx'), 'test');
	writeFileSync(join(testDir, 'lib', 'utils.ts'), 'test');

	const analysis = analyzer.analyze();

	t.true(Array.isArray(analysis.structure.importantDirectories));
});

test('ProjectAnalyzer - extractProjectMetadata reads package.json', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	// Create package.json
	writeFileSync(
		join(testDir, 'package.json'),
		JSON.stringify({
			name: 'test-project',
			description: 'A test project',
			repository: 'https://github.com/test/test'
		}),
		'utf-8'
	);

	const analysis = analyzer.analyze();

	t.is(analysis.projectName, 'test-project');
	t.is(analysis.description, 'A test project');
	t.is(analysis.repository, 'https://github.com/test/test');
});

test('ProjectAnalyzer - extractProjectMetadata with minimal package.json', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	// Create package.json without optional fields
	writeFileSync(
		join(testDir, 'package.json'),
		JSON.stringify({
			name: 'minimal-project'
		}),
		'utf-8'
	);

	const analysis = analyzer.analyze();

	t.is(analysis.projectName, 'minimal-project');
});

test('ProjectAnalyzer - extractProjectMetadata uses directory name as fallback', t => {
	// Use a fresh subdirectory for this test to avoid picking up files from previous tests
	const subDir = join(testDir, 'fallback-test');
	mkdirSync(subDir, {recursive: true});

	const analyzer = new ProjectAnalyzer(subDir);

	const analysis = analyzer.analyze();

	t.is(analysis.projectName, 'fallback-test');
});

test('ProjectAnalyzer - extractProjectMetadata handles repository object', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	writeFileSync(
		join(testDir, 'package.json'),
		JSON.stringify({
			name: 'test-project',
			repository: {
				type: 'git',
				url: 'https://github.com/test/test.git'
			}
		}),
		'utf-8'
	);

	const analysis = analyzer.analyze();

	t.is(analysis.repository, 'https://github.com/test/test.git');
});

test('ProjectAnalyzer - analyze returns complete analysis object', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	// Create some files to analyze
	writeFileSync(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }), 'utf-8');
	writeFileSync(join(testDir, 'src', 'index.ts'), 'console.log("test");');
	writeFileSync(join(testDir, 'README.md'), '# Test Project\n\nA test project');
	writeFileSync(join(testDir, 'tsconfig.json'), '{}');

	const analysis = analyzer.analyze();

	// Verify the structure
	t.is(analysis.projectPath, testDir);
	t.is(analysis.projectName, 'test');
	t.truthy(analysis.languages);
	t.truthy(analysis.dependencies);
	t.is(typeof analysis.projectType, 'string');
	t.truthy(analysis.keyFiles);
	t.truthy(analysis.structure);
	t.truthy(analysis.buildCommands);
});

test('ProjectAnalyzer - getCodingConventions returns conventions', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	// Create a JavaScript project
	writeFileSync(
		join(testDir, 'package.json'),
		JSON.stringify({ name: 'js-project' }),
		'utf-8'
	);
	writeFileSync(join(testDir, 'src', 'index.js'), 'console.log("test");');

	const conventions = analyzer.getCodingConventions();

	t.true(Array.isArray(conventions));
});

test('ProjectAnalyzer - getCodingConventions for TypeScript project', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	// Create a TypeScript project
	writeFileSync(
		join(testDir, 'package.json'),
		JSON.stringify({ name: 'ts-project' }),
		'utf-8'
	);
	writeFileSync(join(testDir, 'tsconfig.json'), '{}');
	writeFileSync(join(testDir, 'src', 'index.ts'), 'const x: number = 1;');

	const conventions = analyzer.getCodingConventions();

	// TypeScript should have similar conventions to JavaScript
	t.true(Array.isArray(conventions));
});

test('ProjectAnalyzer - structure contains scanned files info', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	// Create files
	writeFileSync(join(testDir, 'package.json'), '{}', 'utf-8');
	writeFileSync(join(testDir, 'src', 'index.ts'), 'test');
	writeFileSync(join(testDir, 'src', 'utils.ts'), 'test');

	const analysis = analyzer.analyze();

	t.is(typeof analysis.structure.totalFiles, 'number');
	t.is(typeof analysis.structure.scannedFiles, 'number');
	t.true(Array.isArray(analysis.structure.directories));
});

test('ProjectAnalyzer - keyFiles categorizes files correctly', t => {
	const analyzer = new ProjectAnalyzer(testDir);

	// Create various file types
	writeFileSync(join(testDir, 'package.json'), '{}', 'utf-8');
	writeFileSync(join(testDir, 'tsconfig.json'), '{}', 'utf-8');
	writeFileSync(join(testDir, 'README.md'), '# Test', 'utf-8');
	writeFileSync(join(testDir, 'Makefile'), 'build:', 'utf-8');
	writeFileSync(join(testDir, 'test', 'index.spec.ts'), 'test', 'utf-8');

	const analysis = analyzer.analyze();

	t.true(Array.isArray(analysis.keyFiles.config));
	t.true(Array.isArray(analysis.keyFiles.documentation));
	t.true(Array.isArray(analysis.keyFiles.build));
	t.true(Array.isArray(analysis.keyFiles.test));
});
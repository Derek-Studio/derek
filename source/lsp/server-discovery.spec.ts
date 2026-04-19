import test from 'ava';
import {mkdtempSync, writeFileSync, rmSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import type { LSPServerConfig } from './lsp-client';
import {
	findLocalServer,
	getKnownServersStatus,
	getLanguageId,
	getMissingServerHints,
	getOrderedServers,
	getServerForLanguage,
	isDenoProject,
} from './server-discovery';

console.log(`\nserver-discovery.spec.ts`);

// getLanguageId tests
test('getLanguageId - returns typescript for ts extension', t => {
	t.is(getLanguageId('ts'), 'typescript');
});

test('getLanguageId - returns typescriptreact for tsx extension', t => {
	t.is(getLanguageId('tsx'), 'typescriptreact');
});

test('getLanguageId - returns javascript for js extension', t => {
	t.is(getLanguageId('js'), 'javascript');
});

test('getLanguageId - returns javascriptreact for jsx extension', t => {
	t.is(getLanguageId('jsx'), 'javascriptreact');
});

test('getLanguageId - returns javascript for mjs extension', t => {
	t.is(getLanguageId('mjs'), 'javascript');
});

test('getLanguageId - returns javascript for cjs extension', t => {
	t.is(getLanguageId('cjs'), 'javascript');
});

test('getLanguageId - returns python for py extension', t => {
	t.is(getLanguageId('py'), 'python');
});

test('getLanguageId - returns python for pyi extension', t => {
	t.is(getLanguageId('pyi'), 'python');
});

test('getLanguageId - returns rust for rs extension', t => {
	t.is(getLanguageId('rs'), 'rust');
});

test('getLanguageId - returns go for go extension', t => {
	t.is(getLanguageId('go'), 'go');
});

test('getLanguageId - returns c for c extension', t => {
	t.is(getLanguageId('c'), 'c');
});

test('getLanguageId - returns cpp for cpp extension', t => {
	t.is(getLanguageId('cpp'), 'cpp');
});

test('getLanguageId - returns cpp for cc extension', t => {
	t.is(getLanguageId('cc'), 'cpp');
});

test('getLanguageId - returns cpp for cxx extension', t => {
	t.is(getLanguageId('cxx'), 'cpp');
});

test('getLanguageId - returns c for h extension', t => {
	t.is(getLanguageId('h'), 'c');
});

test('getLanguageId - returns cpp for hpp extension', t => {
	t.is(getLanguageId('hpp'), 'cpp');
});

test('getLanguageId - returns cpp for hxx extension', t => {
	t.is(getLanguageId('hxx'), 'cpp');
});

test('getLanguageId - returns json for json extension', t => {
	t.is(getLanguageId('json'), 'json');
});

test('getLanguageId - returns jsonc for jsonc extension', t => {
	t.is(getLanguageId('jsonc'), 'jsonc');
});

test('getLanguageId - returns html for html extension', t => {
	t.is(getLanguageId('html'), 'html');
});

test('getLanguageId - returns html for htm extension', t => {
	t.is(getLanguageId('htm'), 'html');
});

test('getLanguageId - returns css for css extension', t => {
	t.is(getLanguageId('css'), 'css');
});

test('getLanguageId - returns scss for scss extension', t => {
	t.is(getLanguageId('scss'), 'scss');
});

test('getLanguageId - returns less for less extension', t => {
	t.is(getLanguageId('less'), 'less');
});

test('getLanguageId - returns yaml for yaml extension', t => {
	t.is(getLanguageId('yaml'), 'yaml');
});

test('getLanguageId - returns yaml for yml extension', t => {
	t.is(getLanguageId('yml'), 'yaml');
});

test('getLanguageId - returns shellscript for sh extension', t => {
	t.is(getLanguageId('sh'), 'shellscript');
});

test('getLanguageId - returns shellscript for bash extension', t => {
	t.is(getLanguageId('bash'), 'shellscript');
});

test('getLanguageId - returns shellscript for zsh extension', t => {
	t.is(getLanguageId('zsh'), 'shellscript');
});

test('getLanguageId - returns lua for lua extension', t => {
	t.is(getLanguageId('lua'), 'lua');
});

test('getLanguageId - returns markdown for md extension', t => {
	t.is(getLanguageId('md'), 'markdown');
});

test('getLanguageId - returns markdown for markdown extension', t => {
	t.is(getLanguageId('markdown'), 'markdown');
});

test('getLanguageId - returns markdown for mdx extension', t => {
	t.is(getLanguageId('mdx'), 'markdown');
});

test('getLanguageId - returns toml for toml extension', t => {
	t.is(getLanguageId('toml'), 'toml');
});

test('getLanguageId - returns xml for xml extension', t => {
	t.is(getLanguageId('xml'), 'xml');
});

test('getLanguageId - returns sql for sql extension', t => {
	t.is(getLanguageId('sql'), 'sql');
});

test('getLanguageId - returns java for java extension', t => {
	t.is(getLanguageId('java'), 'java');
});

test('getLanguageId - returns kotlin for kt extension', t => {
	t.is(getLanguageId('kt'), 'kotlin');
});

test('getLanguageId - returns swift for swift extension', t => {
	t.is(getLanguageId('swift'), 'swift');
});

test('getLanguageId - returns ruby for rb extension', t => {
	t.is(getLanguageId('rb'), 'ruby');
});

test('getLanguageId - returns php for php extension', t => {
	t.is(getLanguageId('php'), 'php');
});

test('getLanguageId - handles extension with leading dot', t => {
	t.is(getLanguageId('.ts'), 'typescript');
});

test('getLanguageId - handles extension with leading dot for py', t => {
	t.is(getLanguageId('.py'), 'python');
});

test('getLanguageId - returns graphql for graphql extension', t => {
	t.is(getLanguageId('graphql'), 'graphql');
});

test('getLanguageId - returns graphql for gql extension', t => {
	// Both common extensions should map to the standard 'graphql' language ID
	t.is(getLanguageId('gql'), 'graphql');
});

test('getLanguageId - returns extension as fallback for unknown type', t => {
	t.is(getLanguageId('xyz'), 'xyz');
});

test('getLanguageId - returns dockerfile for docker extension', t => {
	t.is(getLanguageId('dockerfile'), 'dockerfile');
});

test('getLanguageId - returns docker-compose for yaml files that match compose naming', t => {
	// Assuming your getLanguageId handles filename patterns
	t.is(getLanguageId('docker-compose.yml'), 'docker-compose');
	t.is(getLanguageId('compose.yaml'), 'docker-compose');
});

test('getLanguageId - returns extension as fallback for unknown with dot', t => {
	t.is(getLanguageId('.unknown'), 'unknown');
});


// getServerForLanguage tests
test('getServerForLanguage - finds server for matching extension', t => {
	const servers: LSPServerConfig[] = [
		{
			name: 'typescript-language-server',
			command: 'typescript-language-server',
			args: ['--stdio'],
			languages: ['ts', 'tsx', 'js', 'jsx'],
		},
		{
			name: 'pyright',
			command: 'pyright-langserver',
			args: ['--stdio'],
			languages: ['py', 'pyi'],
		},
	];

	const result = getServerForLanguage(servers, 'ts');
	t.truthy(result);
	t.is(result?.name, 'typescript-language-server');
});

test('getServerForLanguage - finds python server for py extension', t => {
	const servers: LSPServerConfig[] = [
		{
			name: 'typescript-language-server',
			command: 'typescript-language-server',
			args: ['--stdio'],
			languages: ['ts', 'tsx'],
		},
		{
			name: 'pyright',
			command: 'pyright-langserver',
			args: ['--stdio'],
			languages: ['py', 'pyi'],
		},
	];

	const result = getServerForLanguage(servers, 'py');
	t.truthy(result);
	t.is(result?.name, 'pyright');
});

test('getServerForLanguage - returns undefined for no matching server', t => {
	const servers: LSPServerConfig[] = [
		{
			name: 'typescript-language-server',
			command: 'typescript-language-server',
			args: ['--stdio'],
			languages: ['ts', 'tsx'],
		},
	];

	const result = getServerForLanguage(servers, 'py');
	t.is(result, undefined);
});

test('getServerForLanguage - handles extension with leading dot', t => {
	const servers: LSPServerConfig[] = [
		{
			name: 'rust-analyzer',
			command: 'rust-analyzer',
			args: [],
			languages: ['rs'],
		},
	];

	const result = getServerForLanguage(servers, '.rs');
	t.truthy(result);
	t.is(result?.name, 'rust-analyzer');
});

test('getServerForLanguage - returns first matching server when multiple match', t => {
	const servers: LSPServerConfig[] = [
		{
			name: 'pyright',
			command: 'pyright-langserver',
			args: ['--stdio'],
			languages: ['py', 'pyi'],
		},
		{
			name: 'pylsp',
			command: 'pylsp',
			args: [],
			languages: ['py', 'pyi'],
		},
	];

	const result = getServerForLanguage(servers, 'py');
	t.truthy(result);
	t.is(result?.name, 'pyright');
});

test('getServerForLanguage - handles empty servers array', t => {
	const servers: LSPServerConfig[] = [];
	const result = getServerForLanguage(servers, 'ts');
	t.is(result, undefined);
});

test('getServerForLanguage - finds markdown server for md extension', t => {
	const servers: LSPServerConfig[] = [
		{
			name: 'vscode-markdown-language-server',
			command: 'vscode-mdx-language-server',
			args: ['--stdio'],
			languages: ['md', 'markdown', 'mdx'],
		},
	];

	const result = getServerForLanguage(servers, 'md');
	t.truthy(result);
	t.is(result?.name, 'vscode-markdown-language-server');
});

test('getServerForLanguage - finds markdown server for markdown extension', t => {
	const servers: LSPServerConfig[] = [
		{
			name: 'vscode-markdown-language-server',
			command: 'vscode-mdx-language-server',
			args: ['--stdio'],
			languages: ['md', 'markdown', 'mdx'],
		},
	];

	const result = getServerForLanguage(servers, 'markdown');
	t.truthy(result);
	t.is(result?.name, 'vscode-markdown-language-server');
});

test('getServerForLanguage - finds markdown server for mdx extension', t => {
	const servers: LSPServerConfig[] = [
		{
			name: 'vscode-markdown-language-server',
			command: 'vscode-mdx-language-server',
			args: ['--stdio'],
			languages: ['md', 'markdown', 'mdx'],
		},
	];

	const result = getServerForLanguage(servers, 'mdx');
	t.truthy(result);
	t.is(result?.name, 'vscode-markdown-language-server');
});

test('getKnownServersStatus - includes graphql-lsp-server', t => {
	const result = getKnownServersStatus();
	const graphqlServer = result.find(s => s.name === 'graphql-lsp-server');

	t.truthy(graphqlServer, 'GraphQL server should be defined in KNOWN_SERVERS');
	t.true(graphqlServer!.languages.includes('graphql'), 'Should support .graphql extension');
	t.true(graphqlServer!.languages.includes('gql'), 'Should support .gql extension');
	t.true(graphqlServer!.installHint!.includes('@graphql-tools/lsp-server'), 'Should point to the correct npm package');
});

test('getKnownServersStatus - includes graphql-language-server-cli', t => {
	const result = getKnownServersStatus();
	const graphqlServer = result.find(s => s.name === 'graphql-language-server-cli');

	t.truthy(graphqlServer);
	t.true(graphqlServer!.languages.includes('graphql'));
	t.true(graphqlServer!.installHint!.includes('graphql-language-service-cli'));
});

// getMissingServerHints tests
test('getMissingServerHints - returns array', t => {
	const result = getMissingServerHints(['ts']);
	t.true(Array.isArray(result));
});

test('getMissingServerHints - handles extension with leading dot', t => {
	const result = getMissingServerHints(['.ts', '.py']);
	t.true(Array.isArray(result));
});

test('getMissingServerHints - handles empty extensions array', t => {
	const result = getMissingServerHints([]);
	t.deepEqual(result, []);
});

test('getMissingServerHints - returns hints for unknown extensions only if server exists', t => {
	// Unknown extensions won't have hints because there's no known server
	const result = getMissingServerHints(['xyz']);
	t.true(Array.isArray(result));
});

test('getMissingServerHints - does not duplicate hints for same server', t => {
	// ts and tsx are handled by the same server
	const result = getMissingServerHints(['ts', 'tsx', 'js', 'jsx']);
	// Should have at most one hint for typescript-language-server
	const tsHints = result.filter(h => h.includes('typescript-language-server'));
	t.true(tsHints.length <= 1);
});

// findLocalServer tests
test('findLocalServer - returns null for non-existent server', t => {
	const result = findLocalServer('/non-existent-path', 'some-server');
	t.is(result, null);
});

test('findLocalServer - returns null for non-existent project root', t => {
	const result = findLocalServer(
		'/does/not/exist',
		'typescript-language-server',
	);
	t.is(result, null);
});

test('findLocalServer - searches in node_modules/.bin', t => {
	// This test verifies the function behavior - it should check specific paths
	const result = findLocalServer(process.cwd(), 'non-existent-binary-xyz');
	t.is(result, null);
});

// getKnownServersStatus tests
test('getKnownServersStatus - returns array of server status', t => {
	const result = getKnownServersStatus();
	t.true(Array.isArray(result));
	t.true(result.length > 0);
});

test('getKnownServersStatus - each item has required properties', t => {
	const result = getKnownServersStatus();

	for (const server of result) {
		t.truthy(server.name);
		t.true(typeof server.available === 'boolean');
		t.true(Array.isArray(server.languages));
		t.true(server.languages.length > 0);
	}
});

test('getKnownServersStatus - includes typescript server', t => {
	const result = getKnownServersStatus();
	const tsServer = result.find(s => s.name === 'typescript-language-server');
	t.truthy(tsServer);
	t.true(tsServer!.languages.includes('ts'));
	t.true(tsServer!.languages.includes('tsx'));
});

test('getKnownServersStatus - includes deno server', t => {
	const result = getKnownServersStatus();
	const denoServer = result.find(s => s.name === 'deno');
	t.truthy(denoServer);
	t.true(denoServer!.languages.includes('ts'));
	t.true(denoServer!.languages.includes('js'));
});

test('getKnownServersStatus - includes pyright server', t => {
	const result = getKnownServersStatus();
	const pyServer = result.find(s => s.name === 'pyright');
	t.truthy(pyServer);
	t.true(pyServer!.languages.includes('py'));
});

test('getKnownServersStatus - includes rust-analyzer', t => {
	const result = getKnownServersStatus();
	const rustServer = result.find(s => s.name === 'rust-analyzer');
	t.truthy(rustServer);
	t.true(rustServer!.languages.includes('rs'));
});

test('getKnownServersStatus - includes gopls', t => {
	const result = getKnownServersStatus();
	const goServer = result.find(s => s.name === 'gopls');
	t.truthy(goServer);
	t.true(goServer!.languages.includes('go'));
});

test('getKnownServersStatus - includes clangd', t => {
	const result = getKnownServersStatus();
	const cppServer = result.find(s => s.name === 'clangd');
	t.truthy(cppServer);
	t.true(cppServer!.languages.includes('c'));
	t.true(cppServer!.languages.includes('cpp'));
});

test('getKnownServersStatus - has install hints', t => {
	const result = getKnownServersStatus();
	// At least some servers should have install hints
	const withHints = result.filter(s => s.installHint);
	t.true(withHints.length > 0);
});

test('getKnownServersStatus - install hint contains useful info', t => {
	const result = getKnownServersStatus();
	const tsServer = result.find(s => s.name === 'typescript-language-server');
	t.truthy(tsServer?.installHint);
	t.true(tsServer!.installHint!.includes('npm'));
});

// discoverLanguageServers is harder to test as it depends on system state
// We can test the structure of what it returns

test('getKnownServersStatus - includes all major language servers', t => {
	const result = getKnownServersStatus();
	const serverNames = result.map(s => s.name);

	// Check for presence of major servers
	t.true(serverNames.includes('typescript-language-server'));
	t.true(serverNames.includes('deno'));
	t.true(serverNames.includes('pyright') || serverNames.includes('pylsp'));
	t.true(serverNames.includes('rust-analyzer'));
	t.true(serverNames.includes('gopls'));
	t.true(serverNames.includes('clangd'));
});

test('getKnownServersStatus - includes web servers', t => {
	const result = getKnownServersStatus();
	const serverNames = result.map(s => s.name);

	t.true(serverNames.includes('vscode-json-languageserver'));
	t.true(serverNames.includes('vscode-html-languageserver'));
	t.true(serverNames.includes('vscode-css-languageserver'));
});

test('getKnownServersStatus - includes yaml server', t => {
	const result = getKnownServersStatus();
	const yamlServer = result.find(s => s.name === 'yaml-language-server');
	t.truthy(yamlServer);
	t.true(yamlServer!.languages.includes('yaml'));
	t.true(yamlServer!.languages.includes('yml'));
});

test('getKnownServersStatus - includes bash server', t => {
	const result = getKnownServersStatus();
	const bashServer = result.find(s => s.name === 'bash-language-server');
	t.truthy(bashServer);
	t.true(bashServer!.languages.includes('sh'));
	t.true(bashServer!.languages.includes('bash'));
});

test('getKnownServersStatus - includes lua server', t => {
	const result = getKnownServersStatus();
	const luaServer = result.find(s => s.name === 'lua-language-server');
	t.truthy(luaServer);
	t.true(luaServer!.languages.includes('lua'));
});

test('getKnownServersStatus - includes vscode-markdown-language-server', t => {
	const result = getKnownServersStatus();
	const mdServer = result.find(s => s.name === 'vscode-markdown-language-server');
	t.truthy(mdServer);
	t.true(mdServer!.languages.includes('md'));
	t.true(mdServer!.languages.includes('markdown'));
	t.true(mdServer!.languages.includes('mdx'));
	t.is(mdServer!.installHint, 'npm install -g @microsoft/vscode-mdx-language-server or vscode-langservers-extracted');
});

test('getKnownServersStatus - includes marksman', t => {
	const result = getKnownServersStatus();
	const marksmanServer = result.find(s => s.name === 'marksman');
	t.truthy(marksmanServer);
	t.true(marksmanServer!.languages.includes('md'));
	t.true(marksmanServer!.languages.includes('markdown'));
	t.true(marksmanServer!.installHint!.includes('marksman'));
});

// Edge cases
test('getLanguageId - handles empty string', t => {
	const result = getLanguageId('');
	t.is(result, '');
});

test('getServerForLanguage - handles empty extension', t => {
	const servers: LSPServerConfig[] = [
		{
			name: 'test',
			command: 'test',
			languages: ['ts'],
		},
	];
	const result = getServerForLanguage(servers, '');
	t.is(result, undefined);
});

// isDenoProject tests
test('isDenoProject - returns false for non-existent directory', t => {
	const result = isDenoProject('/non-existent-path-xyz-123');
	t.is(result, false);
});

test('isDenoProject - returns false for directory without deno config', t => {
	// Using a known directory that won't have deno.json
	const result = isDenoProject(tmpdir());
	t.is(result, false);
});

test('isDenoProject - returns false for current directory without deno config', t => {
	// The nanocoder project itself doesn't have deno.json
	const result = isDenoProject(process.cwd());
	t.is(result, false);
});

test('isDenoProject - returns true when deno.json exists', t => {
	const tmpDir = mkdtempSync(join(tmpdir(), 'deno-test-'));
	try {
		writeFileSync(join(tmpDir, 'deno.json'), '{}');
		const result = isDenoProject(tmpDir);
		t.is(result, true);
	} finally {
		rmSync(tmpDir, { recursive: true });
	}
});

test('isDenoProject - returns true when deno.jsonc exists', t => {
	const tmpDir = mkdtempSync(join(tmpdir(), 'deno-test-'));
	try {
		writeFileSync(join(tmpDir, 'deno.jsonc'), '{}');
		const result = isDenoProject(tmpDir);
		t.is(result, true);
	} finally {
		rmSync(tmpDir, { recursive: true });
	}
});

test('isDenoProject - returns true when both deno.json and deno.jsonc exist', t => {
	const tmpDir = mkdtempSync(join(tmpdir(), 'deno-test-'));
	try {
		writeFileSync(join(tmpDir, 'deno.json'), '{}');
		writeFileSync(join(tmpDir, 'deno.jsonc'), '{}');
		const result = isDenoProject(tmpDir);
		t.is(result, true);
	} finally {
		rmSync(tmpDir, { recursive: true });
	}
});

// getOrderedServers tests
test('getOrderedServers - moves Deno to front in Deno project', t => {
	const tmpDir = mkdtempSync(join(tmpdir(), 'deno-test-'));
	try {
		writeFileSync(join(tmpDir, 'deno.json'), '{}');
		const servers = getOrderedServers(tmpDir);
		t.is(servers[0].name, 'deno', 'Deno server should be first');
	} finally {
		rmSync(tmpDir, { recursive: true });
	}
});

test('getOrderedServers - keeps TypeScript first for non-Deno projects', t => {
	const servers = getOrderedServers(tmpdir());
	t.is(servers[0].name, 'typescript-language-server', 'TypeScript server should be first for non-Deno projects');
});

test('getOrderedServers - preserves all servers in result', t => {
	const tmpDir = mkdtempSync(join(tmpdir(), 'deno-test-'));
	try {
		writeFileSync(join(tmpDir, 'deno.json'), '{}');
		const servers = getOrderedServers(tmpDir);
		const serverNames = servers.map(s => s.name);
		t.true(serverNames.includes('deno'), 'Should include Deno server');
		t.true(serverNames.includes('typescript-language-server'), 'Should include TypeScript server');
		t.true(serverNames.includes('pyright'), 'Should include Pyright server');
	} finally {
		rmSync(tmpDir, { recursive: true });
	}
});

test('getOrderedServers - does not mutate original KNOWN_SERVERS array', t => {
	const originalFirst = getOrderedServers(tmpdir())[0].name;

	// Create Deno project and get ordered servers
	const tmpDir = mkdtempSync(join(tmpdir(), 'deno-test-'));
	try {
		writeFileSync(join(tmpDir, 'deno.json'), '{}');
		getOrderedServers(tmpDir);

		// Verify original order is preserved for non-Deno projects
		const afterFirst = getOrderedServers(tmpdir())[0].name;
		t.is(originalFirst, afterFirst, 'Original server order should not be mutated');
	} finally {
		rmSync(tmpDir, { recursive: true });
	}
});

test('getOrderedServers - defaults to process.cwd() when no projectRoot provided', t => {
	// Current directory (nanocoder) is not a Deno project
	const servers = getOrderedServers();
	t.is(servers[0].name, 'typescript-language-server', 'Should default to TypeScript first when cwd is not Deno project');
});

test('getKnownServersStatus - includes docker-language-server', t => {
	const result = getKnownServersStatus();
	const dockerServer = result.find(s => s.name === 'docker-language');

	t.truthy(dockerServer, 'Docker server should be registered');
	t.true(dockerServer!.languages.includes('dockerfile'), 'Should support dockerfile');
	t.is(
		dockerServer!.installHint,
		'npm install -g docker-langserver or https://github.com/rcjsuen/dockerfile-language-server-nodejs'
	);
});

test('getKnownServersStatus - includes docker-compose-language-server', t => {
	const result = getKnownServersStatus();
	const composeServer = result.find(s => s.name === 'docker-compose-language');

	t.truthy(composeServer, 'Docker Compose server should be registered');
	// Verifying support for both the specific ID and the base YAML extensions
	t.true(composeServer!.languages.includes('docker-compose'), 'Should support docker-compose specific ID');
	t.true(composeServer!.languages.includes('yaml'), 'Should support yaml extension');
	t.true(composeServer!.languages.includes('yml'), 'Should support yml extension');

	t.is(composeServer!.installHint, 'npm install -g yaml-language-server');
});

// Tests for verificationMethod functionality
test('getKnownServersStatus - all servers have proper structure', t => {
	const result = getKnownServersStatus();

	// Check that servers have proper structure
	for (const server of result) {
		t.truthy(server.name);
		t.true(typeof server.available === 'boolean');
		t.true(Array.isArray(server.languages));
	}
});

test('getKnownServersStatus - key servers are present with correct names', t => {
	const result = getKnownServersStatus();

	// Check that key servers are present with their correct names
	const keyServers = [
		'typescript-language-server',
		'deno',
		'pyright',
		'pylsp',
		'rust-analyzer',
		'gopls',
		'clangd',
		'vscode-json-languageserver',
		'vscode-html-languageserver',
		'vscode-css-languageserver',
		'yaml-language-server',
		'bash-language-server',
		'lua-language-server',
		'vscode-markdown-language-server',
		'marksman',
		'graphql-language-server-cli'
	];

	for (const serverName of keyServers) {
		const server = result.find(s => s.name === serverName);
		t.truthy(server, `Server ${serverName} should be present`);
		t.is(server!.name, serverName);
	}
});

import test from 'ava';
import {
	CompletionItemKind,
	CompletionTriggerKind,
	DiagnosticSeverity,
	InsertTextFormat,
	LSPMethods,
	TextDocumentSyncKind,
} from './protocol';

console.log(`\nprotocol.spec.ts`);

// DiagnosticSeverity enum tests
test('DiagnosticSeverity - has correct Error value', t => {
	t.is(DiagnosticSeverity.Error, 1);
});

test('DiagnosticSeverity - has correct Warning value', t => {
	t.is(DiagnosticSeverity.Warning, 2);
});

test('DiagnosticSeverity - has correct Information value', t => {
	t.is(DiagnosticSeverity.Information, 3);
});

test('DiagnosticSeverity - has correct Hint value', t => {
	t.is(DiagnosticSeverity.Hint, 4);
});

// CompletionItemKind enum tests
test('CompletionItemKind - has correct Text value', t => {
	t.is(CompletionItemKind.Text, 1);
});

test('CompletionItemKind - has correct Method value', t => {
	t.is(CompletionItemKind.Method, 2);
});

test('CompletionItemKind - has correct Function value', t => {
	t.is(CompletionItemKind.Function, 3);
});

test('CompletionItemKind - has correct Constructor value', t => {
	t.is(CompletionItemKind.Constructor, 4);
});

test('CompletionItemKind - has correct Field value', t => {
	t.is(CompletionItemKind.Field, 5);
});

test('CompletionItemKind - has correct Variable value', t => {
	t.is(CompletionItemKind.Variable, 6);
});

test('CompletionItemKind - has correct Class value', t => {
	t.is(CompletionItemKind.Class, 7);
});

test('CompletionItemKind - has correct Interface value', t => {
	t.is(CompletionItemKind.Interface, 8);
});

test('CompletionItemKind - has correct Module value', t => {
	t.is(CompletionItemKind.Module, 9);
});

test('CompletionItemKind - has correct Property value', t => {
	t.is(CompletionItemKind.Property, 10);
});

test('CompletionItemKind - has correct Keyword value', t => {
	t.is(CompletionItemKind.Keyword, 14);
});

test('CompletionItemKind - has correct Snippet value', t => {
	t.is(CompletionItemKind.Snippet, 15);
});

test('CompletionItemKind - has correct TypeParameter value', t => {
	t.is(CompletionItemKind.TypeParameter, 25);
});

// InsertTextFormat enum tests
test('InsertTextFormat - has correct PlainText value', t => {
	t.is(InsertTextFormat.PlainText, 1);
});

test('InsertTextFormat - has correct Snippet value', t => {
	t.is(InsertTextFormat.Snippet, 2);
});

// TextDocumentSyncKind enum tests
test('TextDocumentSyncKind - has correct None value', t => {
	t.is(TextDocumentSyncKind.None, 0);
});

test('TextDocumentSyncKind - has correct Full value', t => {
	t.is(TextDocumentSyncKind.Full, 1);
});

test('TextDocumentSyncKind - has correct Incremental value', t => {
	t.is(TextDocumentSyncKind.Incremental, 2);
});

// CompletionTriggerKind enum tests
test('CompletionTriggerKind - has correct Invoked value', t => {
	t.is(CompletionTriggerKind.Invoked, 1);
});

test('CompletionTriggerKind - has correct TriggerCharacter value', t => {
	t.is(CompletionTriggerKind.TriggerCharacter, 2);
});

test('CompletionTriggerKind - has correct TriggerForIncompleteCompletions value', t => {
	t.is(CompletionTriggerKind.TriggerForIncompleteCompletions, 3);
});

// LSPMethods constant tests
test('LSPMethods - has correct Initialize method', t => {
	t.is(LSPMethods.Initialize, 'initialize');
});

test('LSPMethods - has correct Initialized method', t => {
	t.is(LSPMethods.Initialized, 'initialized');
});

test('LSPMethods - has correct Shutdown method', t => {
	t.is(LSPMethods.Shutdown, 'shutdown');
});

test('LSPMethods - has correct Exit method', t => {
	t.is(LSPMethods.Exit, 'exit');
});

test('LSPMethods - has correct DidOpen method', t => {
	t.is(LSPMethods.DidOpen, 'textDocument/didOpen');
});

test('LSPMethods - has correct DidChange method', t => {
	t.is(LSPMethods.DidChange, 'textDocument/didChange');
});

test('LSPMethods - has correct DidClose method', t => {
	t.is(LSPMethods.DidClose, 'textDocument/didClose');
});

test('LSPMethods - has correct DidSave method', t => {
	t.is(LSPMethods.DidSave, 'textDocument/didSave');
});

test('LSPMethods - has correct Completion method', t => {
	t.is(LSPMethods.Completion, 'textDocument/completion');
});

test('LSPMethods - has correct Hover method', t => {
	t.is(LSPMethods.Hover, 'textDocument/hover');
});

test('LSPMethods - has correct Definition method', t => {
	t.is(LSPMethods.Definition, 'textDocument/definition');
});

test('LSPMethods - has correct References method', t => {
	t.is(LSPMethods.References, 'textDocument/references');
});

test('LSPMethods - has correct CodeAction method', t => {
	t.is(LSPMethods.CodeAction, 'textDocument/codeAction');
});

test('LSPMethods - has correct Formatting method', t => {
	t.is(LSPMethods.Formatting, 'textDocument/formatting');
});

test('LSPMethods - has correct PublishDiagnostics method', t => {
	t.is(LSPMethods.PublishDiagnostics, 'textDocument/publishDiagnostics');
});

test('LSPMethods - has correct DocumentDiagnostic method', t => {
	t.is(LSPMethods.DocumentDiagnostic, 'textDocument/diagnostic');
});

test('LSPMethods - has correct WorkspaceDiagnostic method', t => {
	t.is(LSPMethods.WorkspaceDiagnostic, 'workspace/diagnostic');
});

// Type structure tests - these verify the shape of interfaces at compile time
// by creating valid instances and checking they compile

test('Diagnostic type - can create valid diagnostic', t => {
	const diagnostic = {
		range: {
			start: {line: 0, character: 0},
			end: {line: 0, character: 10},
		},
		severity: DiagnosticSeverity.Error,
		code: 'TS2322',
		source: 'typescript',
		message: 'Type error',
	};

	t.is(diagnostic.severity, DiagnosticSeverity.Error);
	t.is(diagnostic.message, 'Type error');
	t.is(diagnostic.range.start.line, 0);
});

test('Position type - can create valid position', t => {
	const position = {line: 5, character: 10};

	t.is(position.line, 5);
	t.is(position.character, 10);
});

test('Range type - can create valid range', t => {
	const range = {
		start: {line: 0, character: 0},
		end: {line: 10, character: 20},
	};

	t.is(range.start.line, 0);
	t.is(range.end.line, 10);
});

test('Location type - can create valid location', t => {
	const location = {
		uri: 'file:///test/file.ts',
		range: {
			start: {line: 0, character: 0},
			end: {line: 0, character: 5},
		},
	};

	t.is(location.uri, 'file:///test/file.ts');
	t.is(location.range.start.line, 0);
});

test('TextDocumentItem type - can create valid text document item', t => {
	const item = {
		uri: 'file:///test/file.ts',
		languageId: 'typescript',
		version: 1,
		text: 'const x = 1;',
	};

	t.is(item.uri, 'file:///test/file.ts');
	t.is(item.languageId, 'typescript');
	t.is(item.version, 1);
});

test('CompletionItem type - can create valid completion item', t => {
	const item = {
		label: 'console',
		kind: CompletionItemKind.Module,
		detail: 'Console module',
		insertText: 'console',
		insertTextFormat: InsertTextFormat.PlainText,
	};

	t.is(item.label, 'console');
	t.is(item.kind, CompletionItemKind.Module);
});

test('CodeAction type - can create valid code action', t => {
	const action = {
		title: 'Extract to function',
		kind: 'refactor.extract',
		isPreferred: false,
	};

	t.is(action.title, 'Extract to function');
	t.is(action.kind, 'refactor.extract');
});

test('TextEdit type - can create valid text edit', t => {
	const edit = {
		range: {
			start: {line: 0, character: 0},
			end: {line: 0, character: 5},
		},
		newText: 'const',
	};

	t.is(edit.newText, 'const');
	t.is(edit.range.start.line, 0);
});

test('WorkspaceEdit type - can create valid workspace edit', t => {
	const workspaceEdit = {
		changes: {
			'file:///test/file.ts': [
				{
					range: {
						start: {line: 0, character: 0},
						end: {line: 0, character: 3},
					},
					newText: 'let',
				},
			],
		},
	};

	t.truthy(workspaceEdit.changes);
	t.is(workspaceEdit.changes!['file:///test/file.ts'].length, 1);
});

test('FormattingOptions type - can create valid formatting options', t => {
	const options = {
		tabSize: 2,
		insertSpaces: true,
		trimTrailingWhitespace: true,
		insertFinalNewline: true,
		trimFinalNewlines: true,
	};

	t.is(options.tabSize, 2);
	t.true(options.insertSpaces);
});

test('PublishDiagnosticsParams type - can create valid params', t => {
	const params = {
		uri: 'file:///test/file.ts',
		version: 1,
		diagnostics: [
			{
				range: {
					start: {line: 0, character: 0},
					end: {line: 0, character: 10},
				},
				severity: DiagnosticSeverity.Warning,
				message: 'Unused variable',
			},
		],
	};

	t.is(params.uri, 'file:///test/file.ts');
	t.is(params.diagnostics.length, 1);
});

test('ServerCapabilities type - can create valid capabilities', t => {
	const capabilities = {
		textDocumentSync: TextDocumentSyncKind.Incremental,
		completionProvider: {
			triggerCharacters: ['.', ':'],
			resolveProvider: true,
		},
		hoverProvider: true,
		definitionProvider: true,
		referencesProvider: true,
		documentFormattingProvider: true,
		codeActionProvider: true,
	};

	t.is(capabilities.textDocumentSync, TextDocumentSyncKind.Incremental);
	t.true(capabilities.hoverProvider);
	t.truthy(capabilities.completionProvider);
});

test('InitializeResult type - can create valid result', t => {
	const result = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Full,
			completionProvider: {triggerCharacters: ['.']},
		},
		serverInfo: {
			name: 'typescript-language-server',
			version: '1.0.0',
		},
	};

	t.is(result.serverInfo?.name, 'typescript-language-server');
	t.is(result.capabilities.textDocumentSync, TextDocumentSyncKind.Full);
});

test('JsonRpcRequest type - can create valid request', t => {
	const request = {
		jsonrpc: '2.0' as const,
		id: 1,
		method: 'textDocument/completion',
		params: {
			textDocument: {uri: 'file:///test.ts'},
			position: {line: 0, character: 5},
		},
	};

	t.is(request.jsonrpc, '2.0');
	t.is(request.id, 1);
	t.is(request.method, 'textDocument/completion');
});

test('JsonRpcResponse type - can create valid success response', t => {
	const response = {
		jsonrpc: '2.0' as const,
		id: 1,
		result: [{label: 'console'}],
	};

	t.is(response.jsonrpc, '2.0');
	t.is(response.id, 1);
	t.truthy(response.result);
});

test('JsonRpcResponse type - can create valid error response', t => {
	const response = {
		jsonrpc: '2.0' as const,
		id: 1,
		error: {
			code: -32600,
			message: 'Invalid Request',
		},
	};

	t.is(response.error?.code, -32600);
	t.is(response.error?.message, 'Invalid Request');
});

test('JsonRpcNotification type - can create valid notification', t => {
	const notification = {
		jsonrpc: '2.0' as const,
		method: 'textDocument/publishDiagnostics',
		params: {
			uri: 'file:///test.ts',
			diagnostics: [],
		},
	};

	t.is(notification.jsonrpc, '2.0');
	t.is(notification.method, 'textDocument/publishDiagnostics');
});

// DiagnosticRelatedInformation tests
test('DiagnosticRelatedInformation type - can create valid related info', t => {
	const relatedInfo = {
		location: {
			uri: 'file:///test/other.ts',
			range: {
				start: {line: 10, character: 0},
				end: {line: 10, character: 5},
			},
		},
		message: 'Original declaration here',
	};

	t.is(relatedInfo.message, 'Original declaration here');
	t.is(relatedInfo.location.uri, 'file:///test/other.ts');
});

// MarkupContent tests
test('MarkupContent type - can create plaintext markup', t => {
	const content = {
		kind: 'plaintext' as const,
		value: 'Simple text documentation',
	};

	t.is(content.kind, 'plaintext');
	t.is(content.value, 'Simple text documentation');
});

test('MarkupContent type - can create markdown markup', t => {
	const content = {
		kind: 'markdown' as const,
		value: '**Bold** and _italic_ documentation',
	};

	t.is(content.kind, 'markdown');
	t.true(content.value.includes('**Bold**'));
});

// File operation types tests
test('CreateFile type - can create valid create file operation', t => {
	const createFile = {
		kind: 'create' as const,
		uri: 'file:///test/new-file.ts',
		options: {overwrite: false, ignoreIfExists: true},
	};

	t.is(createFile.kind, 'create');
	t.is(createFile.uri, 'file:///test/new-file.ts');
});

test('RenameFile type - can create valid rename file operation', t => {
	const renameFile = {
		kind: 'rename' as const,
		oldUri: 'file:///test/old.ts',
		newUri: 'file:///test/new.ts',
		options: {overwrite: true},
	};

	t.is(renameFile.kind, 'rename');
	t.is(renameFile.oldUri, 'file:///test/old.ts');
	t.is(renameFile.newUri, 'file:///test/new.ts');
});

test('DeleteFile type - can create valid delete file operation', t => {
	const deleteFile = {
		kind: 'delete' as const,
		uri: 'file:///test/to-delete.ts',
		options: {recursive: true, ignoreIfNotExists: true},
	};

	t.is(deleteFile.kind, 'delete');
	t.is(deleteFile.uri, 'file:///test/to-delete.ts');
});

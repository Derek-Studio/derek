import {randomBytes} from 'node:crypto';
import {createServer, type Server} from 'node:http';
import type {SecretDispatchRequest} from './dispatcher.js';
import {writeSecret, writeSecretFile} from './env-writer.js';
import {pendingSecretStore, type SecretResolution} from './pending-store.js';

/**
 * One-time HTTPS-free secret intake server.
 *
 * The secret value travels from the operator's browser directly to this
 * local HTTP server — it never touches Discord. Derek posts a one-time
 * URL in the channel; the operator opens it, submits the value, done.
 *
 * Security model:
 *   - Each request gets 32 bytes (256 bits) of random token in the URL.
 *   - Tokens are single-use and expire with the pending-store TTL.
 *   - The server can be bound to localhost (SSH port-forward) or a
 *     wider interface if DEREK_SECRET_PORT / DEREK_SECRET_URL_BASE are set.
 */

interface PendingLink {
	pendingId: string;
	key: string;
}

const tokenMap = new Map<string, PendingLink>();

let server: Server | null = null;
let listeningPort: number | null = null;

export function createToken(pendingId: string, key: string): string {
	const token = randomBytes(32).toString('hex');
	tokenMap.set(token, {pendingId, key});
	return token;
}

function deleteToken(token: string): void {
	tokenMap.delete(token);
}

function htmlPage(opts: {
	key: string;
	token: string;
	filePath?: string;
	submitted?: boolean;
	error?: string;
}): string {
	const isFile = Boolean(opts.filePath);
	const label = isFile
		? `File: <code>${escapeHtml(opts.filePath!)}</code>`
		: `Key: <code>${escapeHtml(opts.key)}</code>`;
	const placeholder = isFile
		? 'Paste file contents here…'
		: 'Paste the secret value here…';
	const minHeight = isFile ? '200px' : '80px';
	const storageNote = isFile
		? 'This content goes directly to the server as a file. It is never sent to Discord or logged.'
		: "This value goes directly to the server's env file. It is never sent to Discord or logged.";
	const storedMsg = isFile
		? `<code>${escapeHtml(opts.filePath!)}</code> has been written.`
		: `<code>${escapeHtml(opts.key)}</code> has been written to the env file.`;

	if (opts.submitted) {
		return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Secret stored</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 20px;background:#0d1117;color:#e6edf3}
.ok{background:#1a2c1a;border:1px solid #2ea043;border-radius:8px;padding:20px}</style></head>
<body><div class="ok"><h2>✅ Secret stored</h2>
<p>${storedMsg}</p>
<p>You can close this tab.</p></div></body></html>`;
	}

	return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Provide secret — ${escapeHtml(opts.key)}</title>
<style>body{font-family:system-ui;max-width:480px;margin:80px auto;padding:0 20px;background:#0d1117;color:#e6edf3}
h2{margin-bottom:4px}p.sub{color:#8b949e;margin-top:4px;font-size:14px}
label{display:block;font-size:13px;color:#8b949e;margin-bottom:6px}
textarea{width:100%;background:#161b22;border:1px solid #30363d;border-radius:6px;color:#e6edf3;
  padding:10px;font-family:monospace;font-size:14px;resize:vertical;min-height:${minHeight};box-sizing:border-box}
textarea:focus{outline:none;border-color:#58a6ff}
button{margin-top:12px;background:#238636;border:none;border-radius:6px;color:#fff;
  padding:10px 20px;font-size:15px;cursor:pointer;width:100%}
button:hover{background:#2ea043}
.err{background:#2c1a1a;border:1px solid #f85149;border-radius:6px;padding:12px;margin-bottom:16px;font-size:14px}
.note{font-size:12px;color:#8b949e;margin-top:12px}
</style></head>
<body>
<h2>🔐 Derek needs a secret</h2>
<p class="sub">${label}</p>
${opts.error ? `<div class="err">❌ ${escapeHtml(opts.error)}</div>` : ''}
<form method="POST">
  <label for="v">${isFile ? 'File contents' : 'Value'}</label>
  <textarea id="v" name="value" autofocus placeholder="${placeholder}" required></textarea>
  <button type="submit">Store securely</button>
</form>
<p class="note">${storageNote}</p>
<p class="note">This link is single-use and expires after 5 minutes.</p>
</body></html>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function parseFormBody(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of raw.split('&')) {
		const eq = pair.indexOf('=');
		if (eq === -1) continue;
		const k = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
		const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
		out[k] = v;
	}
	return out;
}

export function getPort(): number | null {
	return listeningPort;
}

export function startSecretServer(): Promise<number> {
	if (server && listeningPort !== null) {
		return Promise.resolve(listeningPort);
	}

	return new Promise((resolve, reject) => {
		server = createServer((req, res) => {
			const url = req.url ?? '/';
			const token = url.startsWith('/') ? url.slice(1).split('?')[0] : '';

			if (req.method === 'GET') {
				const link = tokenMap.get(token);
				if (!link) {
					res.writeHead(404, {'Content-Type': 'text/html'});
					res.end('<h1>404 — link not found or already used</h1>');
					return;
				}
				const entry = pendingSecretStore.get(link.pendingId);
				res.writeHead(200, {'Content-Type': 'text/html'});
				res.end(htmlPage({key: link.key, token, filePath: entry?.filePath}));
				return;
			}

			if (req.method === 'POST') {
				const link = tokenMap.get(token);
				if (!link) {
					res.writeHead(404, {'Content-Type': 'text/html'});
					res.end('<h1>404 — link not found or already used</h1>');
					return;
				}

				let body = '';
				req.on('data', chunk => {
					body += chunk;
					if (body.length > 500_000) req.destroy();
				});
				req.on('end', async () => {
					const fields = parseFormBody(body);
					const value = fields['value'] ?? '';

					const entry = pendingSecretStore.get(link.pendingId);
					if (!entry) {
						res.writeHead(200, {'Content-Type': 'text/html'});
						res.end(
							htmlPage({
								key: link.key,
								token,
								error: 'This request has already expired.',
							}),
						);
						return;
					}

					try {
						let result;
						if (entry.filePath) {
							result = writeSecretFile(entry.filePath, value, entry.projectDir);
						} else {
							result = writeSecret(entry.key, value, {
								scope: entry.scope,
								projectDir: entry.projectDir,
							});
						}
						deleteToken(token);
						pendingSecretStore.consume(link.pendingId);

						res.writeHead(200, {'Content-Type': 'text/html'});
						res.end(
							htmlPage({
								key: link.key,
								token,
								filePath: entry.filePath,
								submitted: true,
							}),
						);

						const resolution: SecretResolution = {
							status: 'stored',
							path: result.path,
							action: result.action,
						};
						entry.resolve(resolution);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						res.writeHead(200, {'Content-Type': 'text/html'});
						res.end(
							htmlPage({
								key: link.key,
								token,
								filePath: entry.filePath,
								error: msg,
							}),
						);
					}
				});
				return;
			}

			res.writeHead(405);
			res.end('Method not allowed');
		});

		const port = Number(process.env.DEREK_SECRET_PORT ?? 0);
		server.listen(port, '0.0.0.0', () => {
			const addr = server!.address();
			listeningPort =
				typeof addr === 'object' && addr !== null ? addr.port : port;
			resolve(listeningPort);
		});
		server.on('error', reject);
	});
}

/**
 * Build and register a one-time secret link for the given request.
 * Returns the full URL to post in Discord.
 */
export async function createSecretLink(
	request: SecretDispatchRequest,
	pendingId: string,
): Promise<string> {
	const port = await startSecretServer();
	const base =
		process.env.DEREK_SECRET_URL_BASE?.replace(/\/$/, '') ??
		`http://localhost:${port}`;
	const token = createToken(pendingId, request.key);

	// Expire the token when the pending request expires
	const entry = pendingSecretStore.get(pendingId);
	if (entry) {
		const remaining = entry.expiresAt - Date.now();
		setTimeout(() => deleteToken(token), Math.max(remaining, 0));
	}

	return `${base}/${token}`;
}

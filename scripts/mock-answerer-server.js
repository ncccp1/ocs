// @ts-check

/**
 * Local mock "answerer" server for development/testing.
 *
 * - No upstream proxying (safe by default).
 * - CORS enabled so it can be called from browser userscripts.
 * - Reads optional local dataset file to return deterministic results.
 *
 * Usage:
 *   node scripts/mock-answerer-server.js
 *
 * Env:
 *   PORT=3457
 *   MOCK_ANSWERER_DATA=./data/mock-answerer.json
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const defaultPort = Number(process.env.PORT || process.env.MOCK_ANSWERER_PORT || 3457);

const defaultDataPath = path.resolve(__dirname, '../data/mock-answerer.json');
const dataPath = path.resolve(process.env.MOCK_ANSWERER_DATA || defaultDataPath);

/**
 * @typedef {{ question: string; answer: string; extra_data?: any }} MockEntry
 */

/** @type {{ mtimeMs?: number; entries: MockEntry[] }} */
const cache = { mtimeMs: undefined, entries: [] };

function setCors(res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJson(req) {
	return new Promise((resolve, reject) => {
		let raw = '';
		req.setEncoding('utf8');
		req.on('data', (chunk) => {
			raw += chunk;
			// 1MB limit to avoid accidental large payloads
			if (raw.length > 1024 * 1024) {
				reject(new Error('request body too large'));
				req.destroy();
			}
		});
		req.on('end', () => {
			if (!raw) return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch (e) {
				reject(new Error('invalid json body'));
			}
		});
		req.on('error', reject);
	});
}

/**
 * @returns {MockEntry[]}
 */
function loadEntries() {
	try {
		if (!fs.existsSync(dataPath)) return [];
		const stat = fs.statSync(dataPath);
		if (cache.mtimeMs === stat.mtimeMs) return cache.entries;

		const text = fs.readFileSync(dataPath, 'utf8');
		const json = JSON.parse(text);
		const entries = Array.isArray(json)
			? json
					.map((item) => ({
						question: String(item?.question || ''),
						answer: String(item?.answer || ''),
						extra_data: item?.extra_data
					}))
					.filter((e) => e.question && e.answer)
			: [];

		cache.mtimeMs = stat.mtimeMs;
		cache.entries = entries;
		return entries;
	} catch {
		return [];
	}
}

function normalize(text) {
	return String(text || '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

/**
 * @param {string} title
 * @param {MockEntry[]} entries
 * @returns {MockEntry[]}
 */
function search(title, entries) {
	const q = normalize(title);
	if (!q) return [];
	// Simple contains match; keep it deterministic and dependency-free.
	const results = entries.filter((e) => normalize(e.question).includes(q)).slice(0, 10);
	return results;
}

function json(res, statusCode, payload) {
	setCors(res);
	res.statusCode = statusCode;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.end(JSON.stringify(payload));
}

function createServer() {
	return http.createServer(async (req, res) => {
		try {
			setCors(res);

			if (req.method === 'OPTIONS') {
				res.statusCode = 200;
				return res.end();
			}

			const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

			if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
				return json(res, 200, {
					ok: true,
					name: 'mock-answerer',
					port: req.socket?.localPort,
					dataPath,
					count: loadEntries().length
				});
			}

			if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/search')) {
				const body = await readJson(req);
				const title = String(body?.title || body?.question || '');
				const entries = loadEntries();
				const results = search(title, entries);

				if (results.length === 0) {
					// Safe default: do not guess answers if no local match.
					return json(res, 200, { code: 0, msg: 'no results', results: [] });
				}

				return json(res, 200, {
					code: 1,
					results: results.map((r) => ({
						question: r.question,
						answer: r.answer,
						extra_data: r.extra_data || { source: 'local-mock' }
					}))
				});
			}

			return json(res, 404, { code: 0, msg: 'not found' });
		} catch (e) {
			return json(res, 500, { code: 0, msg: e?.message || 'server error' });
		}
	});
}

/**
 * @param {{ port?: number; host?: string } | undefined} [opts]
 */
function startServer(opts) {
	const port = Number(opts?.port ?? defaultPort);
	const host = opts?.host ?? '127.0.0.1';

	const server = createServer();

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => {
			const address = server.address();
			// @ts-ignore - Node types: address may be string | AddressInfo | null
			const actualPort = typeof address === 'object' && address ? address.port : port;

			console.log(`[mock-answerer] listening on http://${host}:${actualPort}`);
			console.log(`[mock-answerer] data: ${dataPath}`);
			resolve({ server, host, port: actualPort });
		});
	});
}

module.exports = { startServer, createServer };

if (require.main === module) {
	// eslint-disable-next-line no-void
	void startServer().catch((e) => {
		console.error('[mock-answerer] failed to start:', e?.message || e);
		process.exitCode = 1;
	});
}

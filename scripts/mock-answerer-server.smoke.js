// @ts-check

const { startServer } = require('./mock-answerer-server');

async function main() {
	/** @type {{ server: import('http').Server; host: string; port: number }} */
	// @ts-ignore - runtime shape
	const { server, host, port } = await startServer({ port: 0, host: '127.0.0.1' });

	try {
		const health = await fetch(`http://${host}:${port}/health`).then((r) => r.json());
		if (!health?.ok) throw new Error('health check failed');

		const search = await fetch(`http://${host}:${port}/search`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json; charset=utf-8' },
			body: JSON.stringify({ title: '1 + 1' })
		}).then((r) => r.json());

		if (search?.code !== 1) throw new Error('search failed');
		if (!Array.isArray(search?.results) || search.results.length === 0) throw new Error('empty results');

		console.log('smoke ok');
	} finally {
		server.close();
	}
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});

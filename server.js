import { createServer } from "node:http";
import { handleRequest } from "./src/index.js";

const PORT = process.env.PORT || 3000;

createServer(async (req, res) => {
	const url = `http://localhost${req.url}`;
	const request = new Request(url, { method: req.method, headers: req.headers });

	const response = await handleRequest(request);

	const headers = {};
	for (const [k, v] of response.headers) headers[k] = v;

	const body = await response.text();
	res.writeHead(response.status, headers);
	res.end(body);
}).listen(PORT, () => {
	console.log(`StreamPeak listening on port ${PORT}`);
});

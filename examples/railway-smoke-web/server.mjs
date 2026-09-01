import http from "node:http";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer from 1 through 65535");
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}\n');
    return;
  }
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("OrbitFlow Railway smoke service\n");
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found\n");
});

server.listen(port, "0.0.0.0");

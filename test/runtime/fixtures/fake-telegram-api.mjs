import http from "node:http";

const port = Number(process.env.FAKE_TELEGRAM_PORT || "8080");
const acceptedToken = process.env.FAKE_TELEGRAM_ACCEPTED_TOKEN || "fact32-present-token";

function reply(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  const method = request.url?.split("/").at(-1);
  const suppliedToken = request.url?.match(/^\/bot([^/]+)\//)?.[1];
  if (suppliedToken !== acceptedToken) {
    process.stdout.write(`fake Telegram rejected ${method ?? "unknown"}\n`);
    reply(response, 401, { ok: false, error_code: 401, description: "Unauthorized" });
    return;
  }

  if (method === "getMe") {
    process.stdout.write("fake Telegram accepted getMe\n");
    reply(response, 200, { ok: true, result: { id: 32001, is_bot: true, first_name: "OrbitFlow proof", username: "orbitflow_proof_bot" } });
    return;
  }
  if (method === "getUpdates") {
    setTimeout(() => reply(response, 200, { ok: true, result: [] }), 100);
    return;
  }
  reply(response, 200, { ok: true, result: true });
});

server.listen(port, "0.0.0.0", () => process.stdout.write(`fake Telegram listening on ${port}\n`));

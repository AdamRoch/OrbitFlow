#!/usr/bin/env node

import http from "node:http";

const port = Number(process.env.PORT ?? 18080);

http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}\n');
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not_found"}\n');
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const proofPrompt = JSON.stringify(messages);
  const toolResult = messages.findLast((message) => message?.role === "tool");
  const message = toolResult
    ? { role: "assistant", content: `PROOF_RESULT ${String(toolResult.content)}` }
    : {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call_${Date.now()}`,
          type: "function",
          function: {
            name: "exec",
            arguments: JSON.stringify({ command: proofCommand(proofPrompt) }),
          },
        }],
      };
  const completion = {
    id: `proof-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: payload.model ?? "proof-model",
    choices: [{ index: 0, message, finish_reason: toolResult ? "stop" : "tool_calls" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
  if (payload.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = toolResult
      ? { role: "assistant", content: message.content }
      : {
          role: "assistant",
          content: null,
          tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })),
        };
    response.write(`data: ${JSON.stringify({
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, delta: {}, finish_reason: toolResult ? "stop" : "tool_calls" }],
      usage: completion.usage,
    })}\n\n`);
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(`${JSON.stringify(completion)}\n`);
}).listen(port, "0.0.0.0");

function proofCommand(prompt) {
  if (prompt.includes("FACT34_DENY_UNLISTED")) return "/usr/bin/id";
  if (prompt.includes("FACT34_DENY_ASSIGNMENT")) {
    return "DATABASE_URL=forbidden /app/bin/orbit-openclaw-tool.mjs list_projects '{\"limit\":10,\"idempotencyKey\":\"fact34-assignment-denied\"}'";
  }
  return "/app/bin/orbit-openclaw-tool.mjs list_projects '{\"limit\":10,\"idempotencyKey\":\"fact34-agent-side-allowed\"}'";
}

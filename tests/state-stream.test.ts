import { describe, expect, it } from "vitest";
import { createHarness } from "./harness";

const api = createHarness();

interface StateClient {
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buffer: string;
}

async function openClient(): Promise<StateClient> {
  const response = await api.fetch("/api/state-stream");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return { response, reader: response.body!.getReader(), buffer: "" };
}

async function nextState(client: StateClient) {
  const decoder = new TextDecoder();
  for (;;) {
    const boundary = client.buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const frame = client.buffer.slice(0, boundary);
      client.buffer = client.buffer.slice(boundary + 2);
      const data = frame.split("\n").find((line) => line.startsWith("data: "));
      if (data) return JSON.parse(data.slice("data: ".length));
      continue;
    }
    const chunk = await client.reader.read();
    if (chunk.done) throw new Error("state stream closed before an event arrived");
    client.buffer += decoder.decode(chunk.value, { stream: true });
  }
}

async function closeClient(client: StateClient) {
  await client.reader.cancel();
}

describe("FACT-18 SSE state stream", () => {
  it("fans one ticket wake-up to two clients and a reconnected client", async () => {
    const first = await openClient();
    const second = await openClient();
    const created = await api.createIssue({ title: "state stream ticket", status: "todo" });
    expect(created.status).toBe(201);

    await expect(nextState(first)).resolves.toMatchObject({
      type: "ticket.created",
      ticketId: String(created.body.id),
      runId: null,
      agentId: null,
    });
    await expect(nextState(second)).resolves.toMatchObject({
      type: "ticket.created",
      ticketId: String(created.body.id),
    });
    await closeClient(first);
    await closeClient(second);

    const reconnected = await openClient();
    const patched = await api.patchIssue(created.body.identifier, { priority: 3 });
    expect(patched.status).toBe(200);
    await expect(nextState(reconnected)).resolves.toMatchObject({
      type: "ticket.updated",
      ticketId: String(created.body.id),
    });
    await closeClient(reconnected);
  });
});

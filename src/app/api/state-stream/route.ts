import { subscribeToStateEvents } from "@/lib/state-stream";
import type { StateEvent } from "@/lib/state-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const HEARTBEAT_MS = 15_000;

function encodeEvent(event: StateEvent): Uint8Array {
  return encoder.encode(`event: state\ndata: ${JSON.stringify(event)}\n\n`);
}

function encodeComment(comment: string): Uint8Array {
  return encoder.encode(`: ${comment}\n\n`);
}

export function GET(request: Request): Response {
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    request.signal.removeEventListener("abort", close);
    try {
      controller?.close();
    } catch {
      // The browser may have cancelled before we observed its abort signal.
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
      const send = (chunk: Uint8Array) => {
        if (closed) return;
        // A slow client is not allowed an unbounded server-side queue. It can
        // reconnect and re-fetch the database-backed snapshot instead.
        if (controller!.desiredSize !== null && controller!.desiredSize < 0) {
          close();
          return;
        }
        controller!.enqueue(chunk);
      };
      unsubscribe = subscribeToStateEvents((event) => send(encodeEvent(event)));
      send(encodeComment("connected"));
      heartbeat = setInterval(() => send(encodeComment("keepalive")), HEARTBEAT_MS);
      request.signal.addEventListener("abort", close, { once: true });
    },
    cancel: close,
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

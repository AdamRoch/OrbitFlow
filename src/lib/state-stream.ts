import { Client } from "pg";
import { parseStateEvent, type StateEvent, type StateEventListener } from "./state-events.ts";

export const STATE_NOTIFICATION_CHANNEL = "orbitflow_state_changed";
const RECONNECT_DELAY_MS = 1_000;

/**
 * One PostgreSQL LISTEN connection fans committed database wake-ups out to the
 * SSE clients held by this Next process. It has no cursor and keeps no replay
 * log. Every successful LISTEN installation emits a resync wake-up, so clients
 * re-fetch their authoritative snapshots after a missed-notification window.
 */
export class StateEventHub {
  private readonly listeners = new Set<StateEventListener>();
  private readonly connectionString = process.env.DATABASE_URL;
  private client: Client | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting: Promise<void> | null = null;

  subscribe(listener: StateEventListener): () => void {
    this.listeners.add(listener);
    void this.connect();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) void this.stop();
    };
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (!this.connectionString || this.listeners.size === 0 || this.client) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const client = new Client({
        connectionString: this.connectionString,
        application_name: "orbitfactory-state-stream",
      });
      client.on("notification", (notification) => {
        if (notification.channel !== STATE_NOTIFICATION_CHANNEL || !notification.payload) return;
        try {
          const event = parseStateEvent(JSON.parse(notification.payload));
          if (event) this.broadcast(event);
        } catch {
          // A malformed notification must not disrupt valid connected clients.
        }
      });
      client.on("error", () => this.reconnect(client));
      client.on("end", () => this.reconnect(client));
      try {
        await client.connect();
        await client.query(`LISTEN ${STATE_NOTIFICATION_CHANNEL}`);
        if (this.listeners.size === 0) {
          await client.end();
          return;
        }
        this.client = client;
        // PostgreSQL does not replay notifications that committed before this
        // LISTEN completed. This is deliberately only a wake-up: connected
        // browsers must re-fetch their bounded, authoritative snapshot.
        this.broadcast({
          schemaVersion: 1,
          type: "state.resync",
          runId: null,
          agentId: null,
          ticketId: null,
          occurredAt: new Date().toISOString(),
        });
      } catch {
        await client.end().catch(() => undefined);
        this.reconnect(client);
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  private reconnect(client: Client): void {
    if (this.client === client) this.client = null;
    if (this.listeners.size === 0 || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private broadcast(event: StateEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

const globalHub = globalThis as typeof globalThis & { orbitfactoryStateEventHub?: StateEventHub };

function getStateEventHub(): StateEventHub {
  globalHub.orbitfactoryStateEventHub ??= new StateEventHub();
  return globalHub.orbitfactoryStateEventHub;
}

export function subscribeToStateEvents(listener: StateEventListener): () => void {
  return getStateEventHub().subscribe(listener);
}

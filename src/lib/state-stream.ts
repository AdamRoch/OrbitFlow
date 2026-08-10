import { Client } from "pg";
import {
  parseStateEvent,
  subscribeLocalStateEvents,
  type StateEvent,
  type StateEventListener,
} from "./state-events.ts";

export const STATE_NOTIFICATION_CHANNEL = "orbitflow_state_changed";

interface StateEventHubOptions {
  connectionString?: string;
  reconnectDelayMs?: number;
}

/**
 * One PostgreSQL LISTEN connection fans committed database wake-ups out to the
 * SSE clients held by this Next process. It has no cursor and keeps no replay
 * log: reconnecting consumers must re-fetch their authoritative snapshots.
 */
export class StateEventHub {
  private readonly listeners = new Set<StateEventListener>();
  private readonly connectionString: string | undefined;
  private readonly reconnectDelayMs: number;
  private client: Client | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting: Promise<void> | null = null;
  private localUnsubscribe: (() => void) | null = null;

  constructor(options: StateEventHubOptions = {}) {
    this.connectionString = options.connectionString ?? process.env.DATABASE_URL;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  }

  subscribe(listener: StateEventListener): () => void {
    this.listeners.add(listener);
    if (!this.localUnsubscribe) {
      this.localUnsubscribe = subscribeLocalStateEvents((event) => this.broadcast(event));
    }
    void this.connect();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) void this.stop();
    };
  }

  /** Useful to proof code: wait until LISTEN is installed before producing rows. */
  async ready(): Promise<void> {
    await this.connect();
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  get listening(): boolean {
    return this.client !== null;
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.localUnsubscribe?.();
    this.localUnsubscribe = null;
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
    }, this.reconnectDelayMs);
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

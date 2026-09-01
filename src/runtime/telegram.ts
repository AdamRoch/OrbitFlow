import { Bot } from "grammy";
import http from "node:http";
import pg from "pg";
import {
  ingestTelegramInbound,
  startTelegramOutboundWorker,
  telegramInboundFromGrammyUpdate,
} from "../lib/telegram/adapter.ts";

const { Pool } = pg;
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const databaseUrl = process.env.DATABASE_URL;
const apiRoot = process.env.ORBITFLOW_TELEGRAM_API_ROOT?.trim();
const healthPort = Number(process.env.ORBITFLOW_TELEGRAM_HEALTH_PORT ?? "3002");
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required for the Telegram adapter");
if (!databaseUrl) throw new Error("DATABASE_URL is required for the Telegram adapter");
if (!Number.isSafeInteger(healthPort) || healthPort < 1 || healthPort > 65_535) {
  throw new Error("ORBITFLOW_TELEGRAM_HEALTH_PORT is invalid");
}

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: "orbitflow-telegram",
});
const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : undefined);
let ready = false;
const outbound = startTelegramOutboundWorker(pool, {
  async sendMessage(chatId, text) {
    const sent = await bot.api.sendMessage(chatId, text);
    return { messageId: sent.message_id };
  },
});

bot.on("message:text", async (context) => {
  await ingestTelegramInbound(pool, telegramInboundFromGrammyUpdate(context.update));
});

bot.catch((error) => {
  process.stderr.write(`Telegram update failed: ${error.message}\n`);
});

const healthServer = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/healthz") {
    response.writeHead(200);
    response.end('{"status":"live","service":"telegram"}\n');
    return;
  }
  if (request.url === "/readyz") {
    try {
      if (!ready) throw new Error("starting");
      await pool.query("SELECT 1");
      response.writeHead(200);
      response.end('{"status":"ready","service":"telegram"}\n');
    } catch {
      response.writeHead(503);
      response.end('{"status":"not_ready","service":"telegram"}\n');
    }
    return;
  }
  response.writeHead(404);
  response.end('{"error":"not_found"}\n');
});

await pool.query("SELECT 1");
ready = true;
healthServer.listen(healthPort, "0.0.0.0", () => {
  process.stdout.write(`OrbitFlow Telegram health server listening on ${healthPort}\n`);
});

async function shutdown() {
  ready = false;
  bot.stop();
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  await outbound.stop();
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown().finally(() => process.exit(0));
  });
}

await bot.start({ allowed_updates: ["message"] });

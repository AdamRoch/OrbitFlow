import { Bot } from "grammy";
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
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required for the Telegram adapter");
if (!databaseUrl) throw new Error("DATABASE_URL is required for the Telegram adapter");

const pool = new Pool({
  connectionString: databaseUrl,
  application_name: "orbitflow-telegram",
});
const bot = new Bot(token, apiRoot ? { client: { apiRoot } } : undefined);
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

async function shutdown() {
  bot.stop();
  await outbound.stop();
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown().finally(() => process.exit(0));
  });
}

await bot.start({ allowed_updates: ["message"] });

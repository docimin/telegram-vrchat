import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { startApi } from "./api.ts";
import { createBot, registerCommands } from "./bot.ts";
import { type Config, loadConfig } from "./config.ts";
import { JobQueue } from "./jobs.ts";
import { addSecret, logError } from "./log.ts";
import { Store } from "./store.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error("Copy .env.example to .env and fill it in.");
  process.exit(1);
}
addSecret(config.telegramToken);
await mkdir(join(config.dataDir, "items"), { recursive: true });

const store = new Store(join(config.dataDir, "bot.sqlite"));
const queue = new JobQueue(store);
const server = startApi({ config, store, queue });
const bot = createBot({ config, store, queue });

async function cleanup(): Promise<void> {
  const old = store.itemsOlderThan(Date.now() - RETENTION_MS);
  for (const item of old) {
    await rm(item.dir, { recursive: true, force: true });
    store.deleteItem(item.id);
  }
  if (old.length) console.log(`Cleaned up ${old.length} old item(s)`);
}

await cleanup();
const cleanupTimer = setInterval(() => {
  cleanup().catch((err) => logError("Cleanup failed:", err));
}, CLEANUP_INTERVAL_MS);

let stopping = false;
async function shutdown(reason: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`${reason}, shutting down`);
  clearInterval(cleanupTimer);
  try {
    if (bot.isRunning()) await bot.stop();
  } catch (err) {
    logError(`Telegram did not confirm the last updates while stopping: ${err instanceof Error ? err.message : String(err)}`);
  }
  await server.stop(true);
  store.close();
  process.exit(code);
}
process.on("SIGINT", () => void shutdown("SIGINT received"));
process.on("SIGTERM", () => void shutdown("SIGTERM received"));

try {
  await bot.init();
  await registerCommands(bot);
} catch (err) {
  logError("Could not connect to Telegram. Check TELEGRAM_BOT_TOKEN.", err);
  await shutdown("Startup failed", 1);
}

console.log(`Companion API listening on ${server.url} (public URL ${config.publicUrl})`);
console.log(`Telegram bot @${bot.botInfo.username} is running`);
try {
  await bot.start({ allowed_updates: ["message", "callback_query"] });
} catch (err) {
  logError("Telegram polling stopped:", err);
  await shutdown("Polling failed", 1);
}

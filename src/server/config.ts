import { resolve } from "node:path";
import { z } from "zod";

const Env = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  ADMIN_TELEGRAM_ID: z.coerce.number().int().positive(),
  PUBLIC_URL: z.url().transform((url) => url.replace(/\/+$/, "")),
  VRCHAT_CONTACT: z.string().min(3, "VRCHAT_CONTACT is required (shown to VRChat in the User-Agent)"),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().default("0.0.0.0"),
  DATA_DIR: z.string().default("./data"),
  DIST_DIR: z.string().default("./dist"),
  TELEGRAM_API_ROOT: z.url().default("https://api.telegram.org").transform((url) => url.replace(/\/+$/, "")),
});

export interface Config {
  telegramToken: string;
  telegramApiRoot: string;
  adminTelegramId: number;
  publicUrl: string;
  vrchatContact: string;
  port: number;
  host: string;
  dataDir: string;
  distDir: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  return {
    telegramToken: e.TELEGRAM_BOT_TOKEN,
    telegramApiRoot: e.TELEGRAM_API_ROOT,
    adminTelegramId: e.ADMIN_TELEGRAM_ID,
    publicUrl: e.PUBLIC_URL,
    vrchatContact: e.VRCHAT_CONTACT,
    port: e.PORT,
    host: e.HOST,
    dataDir: resolve(e.DATA_DIR),
    distDir: resolve(e.DIST_DIR),
  };
}

import { hostname } from "node:os";
import type { Job, JobResult } from "../shared/protocol.ts";
import { type CompanionConfig, configPath, loadConfig, saveConfig } from "./config.ts";
import { PromptCancelled, ask, askHidden } from "./prompt.ts";
import { ServerClient, ServerError, pairDevice } from "./server.ts";
import { processJob } from "./uploader.ts";
import { type CurrentUser, type LoginResult, VRChatApiError, VRChatClient } from "./vrchat.ts";

const APP_NAME = "VRCUploadCompanion";
const VERSION = "0.1.0";
const POLL_SECONDS = 25;

const USAGE = `VRChat upload companion ${VERSION}

Uploads the stickers, emoji and prints you make with the Telegram bot to your
own VRChat account. Your VRChat login stays on this computer.

Usage:
  vrc-companion            pair, log in and start uploading (same as "run")
  vrc-companion run        start uploading
  vrc-companion pair LINK  pair with the bot using the link from /pair
  vrc-companion login      log in to VRChat
  vrc-companion logout     log out of VRChat on this computer
  vrc-companion status     show pairing and login state
  vrc-companion unpair     forget the bot pairing

Config file: ${configPath()}

Made by Herr Coroni`;

type Paired = CompanionConfig & { server: NonNullable<CompanionConfig["server"]> };

function log(message: string): void {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function userAgent(config: Paired): string {
  return `${APP_NAME}/${VERSION} ${config.server.contact}`;
}

function vrchatFor(config: Paired): VRChatClient {
  return new VRChatClient(userAgent(config), config.vrchat?.cookies ?? {});
}

async function pair(config: CompanionConfig, link?: string): Promise<Paired> {
  const pairLink = link ?? (await ask("Paste the pairing link from the bot's /pair message: "));
  const result = await pairDevice(pairLink, hostname().slice(0, 100) || "companion");
  const next: Paired = {
    ...config,
    server: { url: result.serverUrl, token: result.token, contact: result.contact, userName: result.userName },
  };
  await saveConfig(next);
  console.log(`Paired with the bot as ${result.userName}.`);
  return next;
}

async function requirePaired(config: CompanionConfig): Promise<Paired> {
  if (config.server) return config as Paired;
  if (!process.stdin.isTTY) throw new Error("Not paired yet. Run: vrc-companion pair <link from /pair>");
  return pair(config);
}

async function login(config: Paired): Promise<{ config: Paired; user: CurrentUser }> {
  console.log("Log in to VRChat. Your password is only sent to VRChat and is not saved.");
  const client = new VRChatClient(userAgent(config));
  for (;;) {
    const username = await ask("VRChat username or email: ");
    const password = await askHidden("Password: ");
    let result: LoginResult;
    try {
      result = await client.login(username, password);
    } catch (err) {
      if (err instanceof VRChatApiError && err.status === 401) {
        console.log(`Login failed: ${err.message}. Try again.`);
        continue;
      }
      throw err;
    }
    let user: CurrentUser | null = result.status === "ok" ? result.user : null;
    if (result.status === "2fa") {
      const email = result.methods.includes("emailOtp");
      while (!user) {
        const code = (await ask(email ? "Code from the VRChat email: " : "Authenticator code (or a recovery code): ")).replace(/\s+/g, "");
        const method = email ? "emailOtp" : /^\d{6}$/.test(code) ? "totp" : "otp";
        if (!(await client.verifyTwoFactor(method, code))) {
          console.log("That code didn't work, try again.");
          continue;
        }
        user = await client.currentUser();
        if (!user) throw new Error("VRChat accepted the code but the session isn't valid. Try logging in again.");
      }
    }
    if (!user) throw new Error("Login did not complete.");
    const next: Paired = { ...config, vrchat: { cookies: client.cookieRecord(), displayName: user.displayName } };
    await saveConfig(next);
    console.log(`Logged in to VRChat as ${user.displayName}.`);
    return { config: next, user };
  }
}

async function ensureLoggedIn(config: Paired): Promise<{ config: Paired; vrchat: VRChatClient }> {
  const vrchat = vrchatFor(config);
  // Network errors and VRChat outages are retried; a 4xx answer means something retrying won't fix.
  const user = await retrying(
    "VRChat",
    () => vrchat.currentUser(),
    (err) => err instanceof VRChatApiError && err.status < 500 && err.status !== 429,
  );
  if (user) {
    log(`Logged in to VRChat as ${user.displayName}.`);
    return { config, vrchat };
  }
  if (!process.stdin.isTTY) throw new Error("Not logged in to VRChat. Run: vrc-companion login");
  const result = await login(config);
  return { config: result.config, vrchat: vrchatFor(result.config) };
}

async function reportWithRetry(server: ServerClient, jobId: string, result: JobResult): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await server.report(jobId, result);
      return;
    } catch (err) {
      if (err instanceof ServerError && err.status < 500) {
        log(`The bot didn't accept the result (${err.message}).`);
        return;
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
  log("Couldn't report the result to the bot; it will retry the job later.");
}

function isPairingError(err: unknown): boolean {
  return err instanceof ServerError && (err.status === 401 || err.status === 403);
}

// Keep trying while the other side is down or unreachable; give up only on errors retrying can't fix.
async function retrying<T>(what: string, fn: () => Promise<T>, fatal: (err: unknown) => boolean): Promise<T> {
  let backoff = 1000;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (fatal(err)) throw err;
      log(`Can't reach ${what} (${errorText(err)}), retrying in ${Math.round(backoff / 1000)}s.`);
      await sleep(backoff + Math.random() * 1000);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

async function run(initial: CompanionConfig): Promise<void> {
  console.log(`VRChat upload companion ${VERSION}, made by Herr Coroni\n`);
  let config = await requirePaired(initial);
  const server = new ServerClient(config.server.url, config.server.token);
  let me: Awaited<ReturnType<ServerClient["me"]>>;
  try {
    me = await retrying("the bot", () => server.me(), isPairingError);
  } catch (err) {
    if (isPairingError(err)) throw new Error(`${errorText(err)}. Pair again with a new link from /pair.`);
    throw err;
  }
  log(`Connected to the bot as ${me.userName} (${me.queued} upload${me.queued === 1 ? "" : "s"} waiting).`);
  let { config: loggedIn, vrchat } = await ensureLoggedIn(config);
  config = loggedIn;
  log("Waiting for uploads. Leave this window open; press Ctrl+C to stop.");

  let backoff = 1000;
  for (;;) {
    let job: Job | null;
    try {
      job = await server.next(POLL_SECONDS, AbortSignal.timeout((POLL_SECONDS + 15) * 1000));
      backoff = 1000;
    } catch (err) {
      if (isPairingError(err)) {
        throw new Error(`${errorText(err)}. Pair again with a new link from /pair.`);
      }
      log(`Can't reach the bot (${errorText(err)}), retrying in ${Math.round(backoff / 1000)}s.`);
      await sleep(backoff + Math.random() * 1000);
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }
    if (!job) continue;

    log(`Uploading ${job.kind}...`);
    const result = await processJob(job, server, vrchat);
    await reportWithRetry(server, job.id, result);
    if (result.ok) {
      log(`Uploaded ${job.kind} (${result.vrchatId}).`);
      continue;
    }
    log(`Upload failed: ${result.error}`);
    if (result.reason === "session") {
      if (!process.stdin.isTTY) throw new Error("VRChat login expired. Run: vrc-companion login");
      const relogged = await login(config);
      config = relogged.config;
      vrchat = vrchatFor(config);
    }
  }
}

async function status(config: CompanionConfig): Promise<void> {
  if (!config.server) {
    console.log("Not paired with a bot.");
    return;
  }
  const server = new ServerClient(config.server.url, config.server.token);
  try {
    const me = await server.me();
    console.log(`Paired with ${config.server.url} as ${me.userName} (${me.queued} queued).`);
  } catch (err) {
    console.log(`Paired with ${config.server.url}, but the bot says: ${errorText(err)}`);
  }
  const user = await vrchatFor(config as Paired).currentUser();
  console.log(user ? `Logged in to VRChat as ${user.displayName}.` : "Not logged in to VRChat.");
}

async function main(argv: string[]): Promise<void> {
  const [command = "run", ...rest] = argv;
  const config = await loadConfig();
  switch (command) {
    case "run":
      await run(config);
      return;
    case "pair":
      await pair(config, rest[0]);
      return;
    case "login":
      await login(await requirePaired(config));
      return;
    case "logout": {
      if (config.server && config.vrchat) await vrchatFor(config as Paired).logout();
      await saveConfig({ ...config, vrchat: undefined });
      console.log("Logged out of VRChat on this computer.");
      return;
    }
    case "status":
      await status(config);
      return;
    case "unpair":
      await saveConfig({ ...config, server: undefined });
      console.log("Forgot the bot pairing. Use /unpair in Telegram to revoke it on the bot side too.");
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
try {
  await main(args);
} catch (err) {
  if (!(err instanceof PromptCancelled)) {
    console.error(`Error: ${errorText(err)}`);
    process.exitCode = 1;
  }
} finally {
  // Keep a double-clicked Windows console open long enough to read the message.
  if (process.platform === "win32" && args.length === 0 && process.stdin.isTTY) {
    await ask("Press Enter to close.").catch(() => undefined);
  }
}

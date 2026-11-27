import { hostname } from "node:os";
import { basename } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import type { Job, JobResult } from "../shared/protocol.ts";
import { type CompanionConfig, configPath, loadConfig, saveConfig } from "./config.ts";
import { PromptCancelled, ask, askHidden } from "./prompt.ts";
import { ServerClient, ServerError, pairDevice, parsePairLink } from "./server.ts";
import { type UpdateInfo, checkForUpdate, cleanupAfterUpdate, installUpdate, isStandalone, restart } from "./updater.ts";
import { processJob } from "./uploader.ts";
import { type CurrentUser, type LoginResult, VRChatApiError, VRChatClient } from "./vrchat.ts";

const APP_NAME = "VRCUploadCompanion";
// package.json is the single source of the version; releases are tagged v<version>.
const VERSION = pkg.version;
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
  vrc-companion update     check for a newer version and install it
  vrc-companion unpair     forget the bot pairing

On every start it checks GitHub for a newer version and asks before installing it.

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

// Plain-language reason a request to the bot or VRChat failed.
function connectionProblem(err: unknown): string {
  if (err instanceof ServerError) return `it answered HTTP ${err.status}: ${err.message}`;
  if (err instanceof Error) {
    const code = "code" in err ? String(err.code) : "";
    if (code === "ECONNREFUSED") return "nothing is answering at that address";
    if (code === "ENOTFOUND") return "that address doesn't exist";
    if (err.name === "TimeoutError") return "no answer in time";
    if (/CERT|SSL|TLS/i.test(code)) return `its HTTPS certificate isn't valid (${code})`;
    return err.message;
  }
  return String(err);
}

// The name to put in command hints: the downloaded file's own name, or "vrc-companion" from source.
function commandName(): string {
  return isStandalone() ? `./${basename(process.execPath)}` : "vrc-companion";
}

function repairHint(): string {
  return `If the bot moved to a new address, pair again: send /pair to the bot in Telegram, then run ${commandName()} pair <link>`;
}

// Consecutive failures before the companion explains how to pair again.
const HINT_AFTER_FAILURES = 3;

function userAgent(config: Paired): string {
  return `${APP_NAME}/${VERSION} ${config.server.contact}`;
}

function vrchatFor(config: Paired): VRChatClient {
  return new VRChatClient(userAgent(config), config.vrchat?.cookies ?? {});
}

async function pair(config: CompanionConfig, link?: string): Promise<Paired> {
  const pairLink = link ?? (await ask("Paste the pairing link from the bot's /pair message: "));
  const { serverUrl } = parsePairLink(pairLink);
  let result: Awaited<ReturnType<typeof pairDevice>>;
  try {
    result = await pairDevice(pairLink, hostname().slice(0, 100) || "companion");
  } catch (err) {
    if (err instanceof ServerError) throw err;
    throw new Error(`Couldn't reach the bot at ${serverUrl} (${connectionProblem(err)}). Check that the link is complete.`);
  }
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
  if (!process.stdin.isTTY) throw new Error(`Not paired yet. Send /pair to the bot, then run ${commandName()} pair <link>`);
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
async function retrying<T>(
  what: string,
  fn: () => Promise<T>,
  fatal: (err: unknown) => boolean,
  hint?: string,
): Promise<T> {
  let backoff = 1000;
  for (let failures = 1; ; failures++) {
    try {
      return await fn();
    } catch (err) {
      if (fatal(err)) throw err;
      log(`Can't reach ${what} (${connectionProblem(err)}), retrying in ${Math.round(backoff / 1000)}s.`);
      if (hint && failures === HINT_AFTER_FAILURES) log(hint);
      await sleep(backoff + Math.random() * 1000);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

// Look for a newer release and ask before installing it. At startup a successful update restarts
// into the new version; the explicit `update` command just installs it.
async function offerUpdate(explicit: boolean): Promise<void> {
  if (!isStandalone()) {
    if (explicit) console.log("Updates only work for the downloaded companion, not when running from source.");
    return;
  }
  await cleanupAfterUpdate();
  // The process that just installed an update started this one; don't ask again right away.
  if (!explicit && process.env.VRC_COMPANION_UPDATED === "1") return;
  const userAgent = `${APP_NAME}/${VERSION}`;
  let update: UpdateInfo | null;
  try {
    update = await checkForUpdate(VERSION, { userAgent });
  } catch (err) {
    log(`Couldn't check for updates (${errorText(err)}).`);
    return;
  }
  if (!update) {
    if (explicit) console.log(`You have the latest version (${VERSION}).`);
    return;
  }
  if (!process.stdin.isTTY) {
    log(`Version ${update.version} is available: ${update.pageUrl}`);
    return;
  }
  const answer = (await ask(`Version ${update.version} is available (you have ${VERSION}). Install it now? [Y/n] `)).toLowerCase();
  if (answer !== "" && !["y", "yes", "j", "ja"].includes(answer)) {
    log(`Staying on ${VERSION}. You'll be asked again next time.`);
    return;
  }
  log(`Downloading ${update.version}...`);
  try {
    await installUpdate(update, process.execPath, userAgent);
  } catch (err) {
    log(`Update failed (${errorText(err)}). Staying on ${VERSION}; you can download it from ${update.pageUrl}`);
    return;
  }
  if (explicit) {
    log(`Updated to ${update.version}.`);
    return;
  }
  log(`Updated to ${update.version}. Restarting...\n`);
  await restart();
}

async function run(initial: CompanionConfig): Promise<void> {
  console.log(`VRChat upload companion ${VERSION}, made by Herr Coroni\n`);
  await offerUpdate(false);
  let config = await requirePaired(initial);
  const server = new ServerClient(config.server.url, config.server.token);
  let me: Awaited<ReturnType<ServerClient["me"]>>;
  try {
    me = await retrying(`the bot at ${config.server.url}`, () => server.me(), isPairingError, repairHint());
  } catch (err) {
    if (isPairingError(err)) throw new Error(`${errorText(err)}. Pair again with a new link from /pair.`);
    throw err;
  }
  log(`Connected to the bot as ${me.userName} (${me.queued} upload${me.queued === 1 ? "" : "s"} waiting).`);
  let { config: loggedIn, vrchat } = await ensureLoggedIn(config);
  config = loggedIn;
  log("Waiting for uploads. Leave this window open; press Ctrl+C to stop.");

  let backoff = 1000;
  let failures = 0;
  for (;;) {
    let job: Job | null;
    try {
      job = await server.next(POLL_SECONDS, AbortSignal.timeout((POLL_SECONDS + 15) * 1000));
      if (failures > 0) log("Connected to the bot again.");
      backoff = 1000;
      failures = 0;
    } catch (err) {
      if (isPairingError(err)) {
        throw new Error(`${errorText(err)}. Pair again with a new link from /pair.`);
      }
      failures++;
      log(`Can't reach the bot at ${config.server.url} (${connectionProblem(err)}), retrying in ${Math.round(backoff / 1000)}s.`);
      if (failures === HINT_AFTER_FAILURES) log(repairHint());
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
    case "update":
      await offerUpdate(true);
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

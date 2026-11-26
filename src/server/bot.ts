import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Bot, type Context, GrammyError, InlineKeyboard, InputFile } from "grammy";
import { ANIMATION_STYLES, type UploadKind } from "../shared/protocol.ts";
import type { Config } from "./config.ts";
import { convertItem, needsAnimationStyle } from "./items.ts";
import { type JobQueue, itemParams, outputPath, uploadFileName } from "./jobs.ts";
import { MediaError, aspectRatio, inspect, isPrintShaped } from "./media.ts";
import { type ItemRow, type Store, type UserRow, randomId } from "./store.ts";
import { COMPANION_BUILDS } from "./api.ts";
import { addSecret, logError } from "./log.ts";

export interface BotDeps {
  config: Config;
  store: Store;
  queue: JobQueue;
}

type BotContext = Context & { appUser?: UserRow };

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 60;

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

const KIND_LABELS: Record<UploadKind, string> = {
  sticker: "Sticker",
  emoji: "Emoji",
  emojianimated: "Animated emoji",
  print: "Print",
};

const INVENTORY_URL = "https://vrchat.com/home/inventory";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function displayName(ctx: Context): string {
  const from = ctx.from;
  if (!from) return "unknown";
  const full = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return full || from.username || String(from.id);
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function ago(timestamp: number | null): string {
  if (!timestamp) return "never";
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function isNotModified(err: unknown): boolean {
  return err instanceof GrammyError && err.description.includes("message is not modified");
}

function extensionFor(mime: string | undefined, fileName: string | undefined): string | null {
  if (mime && MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime];
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext === "jpeg") return "jpg";
  return ext && Object.values(MIME_EXTENSIONS).includes(ext) ? ext : null;
}

const HELP = `<b>VRChat upload bot</b>

Send me an image and I'll turn it into a VRChat <b>sticker</b>, <b>emoji</b> or <b>print</b>. GIFs and short videos become <b>animated emoji</b>.

- Send photos as a <i>file</i> to keep full quality.
- A caption on a photo becomes the print's note.
- Transparent PNGs keep their transparency as stickers and emoji.

<b>One-tap upload</b>
/pair connects the companion app on your PC. It uploads to your own VRChat account, and your VRChat login never leaves your PC.
Without it, I send you the finished file to upload at ${INVENTORY_URL}.

/pair - connect the companion
/devices - list connected companions
/unpair - disconnect all companions
/help - this message`;

const ADMIN_HELP = `

<b>Admin</b>
/invite - create a one-time invite link
/users - list users
/revoke &lt;telegram id&gt; - remove someone's access`;

const NOT_INVITED = "This bot is invite-only. Ask the owner for an invite link.";

export function createBot(deps: BotDeps): Bot<BotContext> {
  const { config, store, queue } = deps;
  addSecret(config.telegramToken);
  const bot = new Bot<BotContext>(config.telegramToken, { client: { apiRoot: config.telegramApiRoot } });
  const busy = new Set<string>();

  const isAdmin = (user: UserRow) => user.telegram_id === config.adminTelegramId;

  const ensureUser = (ctx: Context): UserRow | null => {
    if (!ctx.from) return null;
    const user = store.upsertTelegramUser(ctx.from.id, displayName(ctx));
    if (isAdmin(user) && !user.allowed) {
      store.setAllowed(user.id, true);
      return { ...user, allowed: 1 };
    }
    return user;
  };

  const helpFor = (user: UserRow) => (isAdmin(user) ? HELP + ADMIN_HELP : HELP);

  // Rendering of an item's result message.

  const view = (item: ItemRow): { caption: string; keyboard: InlineKeyboard | undefined } => {
    const params = itemParams(item);
    const label = item.kind ? KIND_LABELS[item.kind] : "Image";
    const details: string[] = [];
    if (item.kind === "emojianimated" && params.frames && params.fps) {
      details.push(`${params.frames} frames at ${params.fps} fps`);
    }
    if (params.animationStyle) details.push(`effect: ${params.animationStyle}`);
    if (item.kind === "print" && params.note) details.push(`note: "${esc(params.note.slice(0, 200))}"`);
    const head = `<b>${label}</b>${details.length ? ` (${details.join(", ")})` : ""}`;

    if (item.status === "ready" && needsAnimationStyle(item)) {
      const kb = new InlineKeyboard();
      ANIMATION_STYLES.forEach((style, i) => {
        kb.text(titleCase(style), `a:${item.id}:${i}`);
        if (i % 3 === 2) kb.row();
      });
      kb.row().text("Discard", `x:${item.id}`);
      return { caption: `${head}\nPick an effect for the emoji:`, keyboard: kb };
    }

    switch (item.status) {
      case "new":
      case "ready":
        return {
          caption: `${head}\nTap <b>Upload to VRChat</b> to send it to your account through your companion, or upload this file yourself at ${INVENTORY_URL}.`,
          keyboard: new InlineKeyboard().text("Upload to VRChat", `u:${item.id}`).text("Discard", `x:${item.id}`),
        };
      case "queued":
        return {
          caption: `${head}\nQueued. Your companion uploads it as soon as it's running and logged in.`,
          keyboard: new InlineKeyboard().text("Cancel", `x:${item.id}`),
        };
      case "uploading":
        return { caption: `${head}\nUploading to VRChat...`, keyboard: undefined };
      case "done":
        return { caption: `${head}\nUploaded to your VRChat account.`, keyboard: undefined };
      case "failed":
        return {
          caption: `${head}\nUpload failed: ${esc((item.error ?? "unknown error").slice(0, 300))}`,
          keyboard: new InlineKeyboard().text("Retry", `u:${item.id}`).text("Discard", `x:${item.id}`),
        };
      case "cancelled":
        return { caption: `${head}\nDiscarded.`, keyboard: undefined };
    }
  };

  const refresh = async (item: ItemRow): Promise<void> => {
    if (!item.message_id) return;
    const { caption, keyboard } = view(item);
    try {
      await bot.api.editMessageCaption(item.chat_id, item.message_id, {
        caption,
        parse_mode: "HTML",
        reply_markup: keyboard ?? { inline_keyboard: [] },
      });
    } catch (err) {
      if (!isNotModified(err)) logError(`Failed to update message for item ${item.id}:`, err);
    }
  };

  queue.onEvent((event) => {
    if (event.type === "item") {
      void refresh(event.item);
      return;
    }
    const user = store.userById(event.userId);
    if (user?.telegram_id) {
      void bot.api
        .sendMessage(
          user.telegram_id,
          "Your companion's VRChat login expired. Open the companion and log in again; queued uploads continue after that.",
        )
        .catch((err) => logError("Failed to send session notice:", err));
    }
  });

  const download = async (fileId: string, dest: string): Promise<void> => {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new MediaError("Telegram didn't hand me that file, try sending it again.");
    const res = await fetch(`${config.telegramApiRoot}/file/bot${config.telegramToken}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram file download failed with status ${res.status}`);
    await Bun.write(dest, res);
  };

  const sendResult = async (ctx: BotContext, item: ItemRow): Promise<void> => {
    const { caption, keyboard } = view(item);
    const sent = await ctx.replyWithDocument(new InputFile(outputPath(item), uploadFileName(item)), {
      caption,
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    store.updateItem(item.id, { message_id: sent.message_id });
  };

  const reportFailure = async (ctx: BotContext, err: unknown): Promise<void> => {
    if (err instanceof MediaError) {
      await ctx.reply(err.message);
      return;
    }
    logError("Conversion failed:", err);
    await ctx.reply("Something went wrong converting that. Try another file, or send it in a different format.");
  };

  const intake = async (
    ctx: BotContext,
    file: { fileId: string; size: number | undefined; ext: string; animated: boolean },
  ): Promise<void> => {
    const user = ctx.appUser;
    const msg = ctx.msg;
    if (!user || !msg || !ctx.chat) return;
    if (file.size !== undefined && file.size > MAX_DOWNLOAD_BYTES) {
      await ctx.reply("That file is over 20MB, which is the most a Telegram bot can download.");
      return;
    }
    const id = randomId();
    const dir = join(config.dataDir, "items", id);
    const inputName = `input.${file.ext}`;
    await mkdir(dir, { recursive: true });
    try {
      await ctx.replyWithChatAction("upload_document");
      await download(file.fileId, join(dir, inputName));
      const source = file.animated ? "animated" : await inspect(join(dir, inputName), file.ext);
      let item = store.createItem({
        id,
        user_id: user.id,
        chat_id: ctx.chat.id,
        source,
        dir,
        input_name: inputName,
        caption: msg.caption?.trim() || null,
        taken_at: msg.date * 1000,
      });
      if (source === "animated") {
        item = await convertItem(store, item, "emojianimated");
        await sendResult(ctx, item);
        return;
      }
      await ctx.reply("What should this become?", {
        reply_markup: new InlineKeyboard()
          .text("Sticker", `k:${id}:sticker`)
          .text("Emoji", `k:${id}:emoji`)
          .text("Print", `k:${id}:print`)
          .row()
          .text("Discard", `x:${id}`),
      });
    } catch (err) {
      if (!store.item(id)) await rm(dir, { recursive: true, force: true });
      await reportFailure(ctx, err);
    }
  };

  // Only private chats. Everything a user does with the bot stays in their own DM.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") return;
    await next();
  });

  bot.command("start", async (ctx) => {
    let user = ensureUser(ctx);
    if (!user) return;
    const payload = ctx.match.trim();
    if (!user.allowed && payload.startsWith("inv") && store.useInvite(payload, user.id)) {
      store.setAllowed(user.id, true);
      user = { ...user, allowed: 1 };
    }
    if (!user.allowed) {
      await ctx.reply(NOT_INVITED);
      return;
    }
    await ctx.reply(helpFor(user), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  // Access gate for everything below.
  bot.use(async (ctx, next) => {
    const user = ensureUser(ctx);
    if (!user) return;
    if (!user.allowed) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: NOT_INVITED, show_alert: true });
      else await ctx.reply(NOT_INVITED);
      return;
    }
    ctx.appUser = user;
    await next();
  });

  bot.command("help", async (ctx) => {
    if (!ctx.appUser) return;
    await ctx.reply(helpFor(ctx.appUser), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  });

  bot.command("pair", async (ctx) => {
    if (!ctx.appUser) return;
    const code = store.createPairCode(ctx.appUser.id);
    const link = `${config.publicUrl}/pair/${code}`;
    const downloads = (Object.keys(COMPANION_BUILDS) as Array<keyof typeof COMPANION_BUILDS>)
      .map((p) => `<a href="${config.publicUrl}/download/${p}">${titleCase(p)}</a>`)
      .join(" | ");
    await ctx.reply(
      `<b>Pair the companion</b>

1. Download it: ${downloads}
2. Run it and paste this link when it asks (single use, valid 10 minutes):
<code>${esc(link)}</code>
3. Log in to VRChat inside the companion. Your password and session stay on your PC; the bot never sees them.

Keep the companion running whenever you want uploads to go through.`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  });

  bot.command("devices", async (ctx) => {
    if (!ctx.appUser) return;
    const devices = store.devices(ctx.appUser.id);
    if (devices.length === 0) {
      await ctx.reply("No companion connected. Use /pair to set one up.");
      return;
    }
    const lines = devices.map((d) => `- ${esc(d.name)} (last seen ${ago(d.last_seen_at)})`);
    await ctx.reply(`<b>Connected companions</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
  });

  bot.command("unpair", async (ctx) => {
    if (!ctx.appUser) return;
    const removed = store.deleteDevices(ctx.appUser.id);
    await ctx.reply(removed ? `Disconnected ${removed} companion(s).` : "No companion was connected.");
  });

  bot.command("invite", async (ctx) => {
    if (!ctx.appUser || !isAdmin(ctx.appUser)) return;
    const code = store.createInvite(ctx.appUser.id);
    await ctx.reply(
      `One-time invite link:\nhttps://t.me/${bot.botInfo.username}?start=${code}`,
      { link_preview_options: { is_disabled: true } },
    );
  });

  bot.command("users", async (ctx) => {
    if (!ctx.appUser || !isAdmin(ctx.appUser)) return;
    const lines = store.allowedUsers().map((u) => {
      const devices = store.devices(u.id).length;
      return `- ${esc(u.name)} (<code>${u.telegram_id ?? "?"}</code>, ${devices} companion${devices === 1 ? "" : "s"})`;
    });
    await ctx.reply(`<b>Users</b>\n${lines.join("\n") || "none"}`, { parse_mode: "HTML" });
  });

  bot.command("revoke", async (ctx) => {
    if (!ctx.appUser || !isAdmin(ctx.appUser)) return;
    const telegramId = Number(ctx.match.trim());
    const target = Number.isInteger(telegramId) ? store.userByTelegramId(telegramId) : null;
    if (!target) {
      await ctx.reply("Usage: /revoke <telegram id> (see /users)");
      return;
    }
    if (isAdmin(target)) {
      await ctx.reply("You can't revoke yourself.");
      return;
    }
    store.setAllowed(target.id, false);
    store.deleteDevices(target.id);
    await ctx.reply(`Revoked access for ${target.name}.`);
  });

  // Incoming media.

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.msg.photo.at(-1);
    if (!photo) return;
    await intake(ctx, { fileId: photo.file_id, size: photo.file_size, ext: "jpg", animated: false });
  });

  bot.on("message:animation", async (ctx) => {
    const anim = ctx.msg.animation;
    const ext = extensionFor(anim.mime_type, anim.file_name) ?? "mp4";
    await intake(ctx, { fileId: anim.file_id, size: anim.file_size, ext, animated: true });
  });

  bot.on("message:video", async (ctx) => {
    const video = ctx.msg.video;
    if (video.duration > MAX_VIDEO_SECONDS) {
      await ctx.reply(`Videos can be at most ${MAX_VIDEO_SECONDS} seconds. Emoji only hold 64 frames anyway, so short clips look best.`);
      return;
    }
    const ext = extensionFor(video.mime_type, video.file_name) ?? "mp4";
    await intake(ctx, { fileId: video.file_id, size: video.file_size, ext, animated: true });
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.msg.document;
    const ext = extensionFor(doc.mime_type, doc.file_name);
    if (!ext) {
      await ctx.reply("I can read PNG, JPG, WebP, GIF, MP4, WebM and MOV files.");
      return;
    }
    const animated = ["mp4", "webm", "mov"].includes(ext);
    await intake(ctx, { fileId: doc.file_id, size: doc.file_size, ext, animated });
  });

  bot.on("message:sticker", async (ctx) => {
    await ctx.reply("Telegram stickers aren't supported yet. Send the image as a photo or file instead.");
  });

  bot.on("message:text", async (ctx) => {
    await ctx.reply("Send me an image, GIF or short video. /help shows what I can do.");
  });

  // Buttons.

  const ownItem = async (ctx: BotContext, id: string): Promise<ItemRow | null> => {
    const item = store.item(id);
    if (!item || !ctx.appUser || item.user_id !== ctx.appUser.id) {
      await ctx.answerCallbackQuery({ text: "That item is gone.", show_alert: true });
      return null;
    }
    return item;
  };

  const convertAndSend = async (ctx: BotContext, item: ItemRow, kind: UploadKind, mode: "fill" | "fit") => {
    if (busy.has(item.id)) {
      await ctx.answerCallbackQuery({ text: "Already working on it." });
      return;
    }
    busy.add(item.id);
    try {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(`Making a ${KIND_LABELS[kind].toLowerCase()}...`);
      await ctx.replyWithChatAction("upload_document");
      const converted = await convertItem(store, item, kind, mode);
      await sendResult(ctx, converted);
      await ctx.deleteMessage().catch(() => undefined);
    } catch (err) {
      await ctx.editMessageText("Conversion failed.").catch(() => undefined);
      await reportFailure(ctx, err);
    } finally {
      busy.delete(item.id);
    }
  };

  bot.callbackQuery(/^k:(\w+):(sticker|emoji|print)$/, async (ctx) => {
    const [, id = "", kind = ""] = ctx.match;
    const item = await ownItem(ctx, id);
    if (!item) return;
    if (item.status !== "new") {
      await ctx.answerCallbackQuery({ text: "Already converted." });
      return;
    }
    if (kind === "print" && !isPrintShaped(await aspectRatio(join(item.dir, item.input_name)))) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageText("Prints are 16:9. Crop the photo to fill the print, or fit the whole photo on a blurred background?", {
        reply_markup: new InlineKeyboard()
          .text("Crop to fill", `p:${id}:fill`)
          .text("Fit whole photo", `p:${id}:fit`)
          .row()
          .text("Discard", `x:${id}`),
      });
      return;
    }
    await convertAndSend(ctx, item, kind === "sticker" ? "sticker" : kind === "emoji" ? "emoji" : "print", "fill");
  });

  bot.callbackQuery(/^p:(\w+):(fill|fit)$/, async (ctx) => {
    const [, id = "", mode = ""] = ctx.match;
    const item = await ownItem(ctx, id);
    if (!item) return;
    if (item.status !== "new") {
      await ctx.answerCallbackQuery({ text: "Already converted." });
      return;
    }
    await convertAndSend(ctx, item, "print", mode === "fit" ? "fit" : "fill");
  });

  bot.callbackQuery(/^a:(\w+):(\d+)$/, async (ctx) => {
    const [, id = "", index = ""] = ctx.match;
    const item = await ownItem(ctx, id);
    if (!item) return;
    const style = ANIMATION_STYLES[Number(index)];
    if (!style || item.status !== "ready") {
      await ctx.answerCallbackQuery();
      return;
    }
    const params = { ...itemParams(item), animationStyle: style };
    const updated = store.updateItem(item.id, { params: JSON.stringify(params) });
    await ctx.answerCallbackQuery({ text: `Effect: ${style}` });
    await refresh(updated);
  });

  bot.callbackQuery(/^u:(\w+)$/, async (ctx) => {
    const [, id = ""] = ctx.match;
    const item = await ownItem(ctx, id);
    if (!item || !ctx.appUser) return;
    if (item.status !== "ready" && item.status !== "failed") {
      await ctx.answerCallbackQuery();
      return;
    }
    if (needsAnimationStyle(item)) {
      await ctx.answerCallbackQuery({ text: "Pick an effect first." });
      return;
    }
    if (store.devices(ctx.appUser.id).length === 0) {
      await ctx.answerCallbackQuery({
        text: "No companion connected yet. Send /pair to set it up, then tap Upload again.",
        show_alert: true,
      });
      return;
    }
    queue.enqueue(item.id);
    await ctx.answerCallbackQuery({ text: "Queued for upload." });
  });

  bot.callbackQuery(/^x:(\w+)$/, async (ctx) => {
    const [, id = ""] = ctx.match;
    const item = await ownItem(ctx, id);
    if (!item) return;
    if (!["new", "ready", "queued", "failed"].includes(item.status)) {
      await ctx.answerCallbackQuery({ text: "Too late to cancel." });
      return;
    }
    queue.cancel(item.id);
    await ctx.answerCallbackQuery({ text: "Discarded." });
    if (!item.message_id) await ctx.editMessageText("Discarded.").catch(() => undefined);
  });

  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "That button no longer works." });
  });

  bot.catch((err) => {
    logError(`Error while handling update ${err.ctx.update.update_id}:`, err.error);
  });

  return bot;
}

export async function registerCommands(bot: Bot<BotContext>): Promise<void> {
  await bot.api.setMyCommands([
    { command: "help", description: "What this bot does" },
    { command: "pair", description: "Connect the companion for one-tap upload" },
    { command: "devices", description: "List connected companions" },
    { command: "unpair", description: "Disconnect all companions" },
  ]);
}

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import sharp from "sharp";
import { createBot } from "../src/server/bot.ts";
import type { Config } from "../src/server/config.ts";
import { JobQueue, outputPath } from "../src/server/jobs.ts";
import { Store } from "../src/server/store.ts";

interface Call {
  method: string;
  params: Record<string, unknown>;
}

const ADMIN = 1000;
const FRIEND = 2000;
const STRANGER = 3000;

let dir = "";
let store: Store;
let queue: JobQueue;
let bot: ReturnType<typeof createBot>;
let telegram: ReturnType<typeof Bun.serve>;
const calls: Call[] = [];
const fixtures = new Map<string, string>();
let nextMessageId = 100;
let nextUpdateId = 1;

function startMockTelegram() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const file = /^\/file\/bot[^/]+\/(.+)$/.exec(url.pathname);
      if (file?.[1]) {
        const path = fixtures.get(file[1]);
        return path ? new Response(Bun.file(path)) : new Response("missing", { status: 404 });
      }
      const method = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname)?.[1] ?? "unknown";
      const params: Record<string, unknown> = {};
      const type = req.headers.get("content-type") ?? "";
      if (type.includes("application/json")) {
        Object.assign(params, (await req.json()) as Record<string, unknown>);
      } else if (type.includes("multipart/form-data")) {
        for (const [key, value] of (await req.formData()).entries()) {
          params[key] = typeof value === "string" ? value : `<file ${value.name}>`;
        }
      }
      for (const key of ["reply_markup", "reply_parameters"]) {
        const value = params[key];
        if (typeof value === "string") params[key] = JSON.parse(value);
      }
      for (const [key, value] of Object.entries(params)) {
        if (typeof value === "string" && value.startsWith("attach://")) params[key] = params[value.slice(9)];
      }
      calls.push({ method, params });
      let result: unknown = true;
      if (method === "getMe") {
        result = { id: 1, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
      } else if (method === "getFile") {
        result = { file_id: params.file_id, file_unique_id: "u", file_path: params.file_id };
      } else if (method === "sendMessage" || method === "sendDocument") {
        result = { message_id: nextMessageId++, date: 0, chat: { id: Number(params.chat_id), type: "private", first_name: "x" } };
      }
      return Response.json({ ok: true, result });
    },
  });
}

function person(id: number) {
  return { id, is_bot: false, first_name: `User${id}` };
}

function chat(id: number) {
  return { id, type: "private" as const, first_name: `User${id}` };
}

async function send(update: Omit<Update, "update_id">): Promise<void> {
  await bot.handleUpdate({ update_id: nextUpdateId++, ...update } as Update);
  await Bun.sleep(30);
}

function message(from: number, extra: Record<string, unknown>) {
  return { message: { message_id: nextMessageId++, date: 1_700_000_000, chat: chat(from), from: person(from), ...extra } } as Omit<Update, "update_id">;
}

function command(from: number, text: string) {
  const name = text.split(" ")[0] ?? text;
  return message(from, { text, entities: [{ type: "bot_command", offset: 0, length: name.length }] });
}

function press(from: number, data: string, messageId: number) {
  return {
    callback_query: {
      id: `cb${nextUpdateId}`,
      from: person(from),
      chat_instance: "ci",
      data,
      message: { message_id: messageId, date: 0, chat: chat(from), text: "x" },
    },
  } as Omit<Update, "update_id">;
}

function last(method: string): Call {
  const call = calls.findLast((c) => c.method === method);
  if (!call) throw new Error(`No ${method} call (got ${calls.map((c) => c.method).join(", ")})`);
  return call;
}

function buttons(call: Call): string[] {
  const markup = call.params.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? "");
}

function itemIdFrom(call: Call): string {
  const id = buttons(call)[0]?.split(":")[1];
  if (!id) throw new Error("No item id in keyboard");
  return id;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vrc-bot-"));
  await mkdir(join(dir, "fixtures"));
  const logo = join(dir, "fixtures", "logo.png");
  await sharp({ create: { width: 400, height: 300, channels: 4, background: { r: 0, g: 200, b: 0, alpha: 0.8 } } }).png().toFile(logo);
  fixtures.set("documents/logo.png", logo);
  const portrait = join(dir, "fixtures", "portrait.jpg");
  await sharp({ create: { width: 600, height: 1000, channels: 3, background: "#3366cc" } }).jpeg().toFile(portrait);
  fixtures.set("photos/portrait.jpg", portrait);
  const clip = join(dir, "fixtures", "clip.mp4");
  await Bun.spawn(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=10", "-pix_fmt", "yuv420p", clip]).exited;
  fixtures.set("animations/clip.mp4", clip);
  const whiteBg = join(dir, "fixtures", "whitebg.jpg");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#fff"/>
    <circle cx="200" cy="200" r="120" fill="#fff" stroke="#111" stroke-width="12"/><circle cx="200" cy="200" r="40" fill="#36c"/></svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toFile(whiteBg);
  fixtures.set("photos/whitebg.jpg", whiteBg);

  telegram = startMockTelegram();
  store = new Store(join(dir, "bot.sqlite"));
  queue = new JobQueue(store);
  const config: Config = {
    telegramToken: "123456:TEST",
    telegramApiRoot: telegram.url.origin,
    adminTelegramId: ADMIN,
    publicUrl: "https://bot.example.invalid",
    vrchatContact: "owner@example.invalid",
    port: 0,
    host: "127.0.0.1",
    dataDir: dir,
    distDir: dir,
  };
  bot = createBot({ config, store, queue });
  await bot.init();
});

afterAll(async () => {
  await telegram.stop(true);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  calls.length = 0;
});

describe("access", () => {
  test("strangers are turned away, group chats are ignored", async () => {
    await send(message(STRANGER, { photo: [{ file_id: "photos/portrait.jpg", file_unique_id: "p", width: 600, height: 1000 }] }));
    expect(last("sendMessage").params.text).toContain("invite-only");
    expect(calls.some((c) => c.method === "getFile")).toBe(false);

    calls.length = 0;
    await bot.handleUpdate({
      update_id: nextUpdateId++,
      message: { message_id: 1, date: 0, chat: { id: -5, type: "group", title: "g" }, from: person(FRIEND), text: "/help" },
    } as Update);
    expect(calls).toHaveLength(0);
  });

  test("admin invite link lets a friend in exactly once", async () => {
    await send(command(ADMIN, "/invite"));
    const text = String(last("sendMessage").params.text);
    const code = /start=(inv\w+)/.exec(text)?.[1];
    expect(text).toContain("https://t.me/test_bot?start=");
    expect(code).toBeDefined();

    await send(command(FRIEND, `/start ${code}`));
    expect(last("sendMessage").params.text).toContain("VRChat upload bot");
    expect(last("sendMessage").params.text).toContain("<i>Made by Herr Coroni</i>");
    expect(store.userByTelegramId(FRIEND)?.allowed).toBe(1);

    await send(command(STRANGER, `/start ${code}`));
    expect(last("sendMessage").params.text).toContain("invite-only");
  });
});

describe("conversion flow", () => {
  test("PNG file becomes a sticker, upload needs a paired companion, then queues and finishes", async () => {
    await send(message(FRIEND, { document: { file_id: "documents/logo.png", file_unique_id: "d", file_name: "logo.png", mime_type: "image/png" } }));
    const picker = last("sendMessage");
    expect(picker.params.text).toBe("What should this become?\n\nTransparent background detected, it will be kept.");
    const id = itemIdFrom(picker);
    expect(buttons(picker)).toEqual([`k:${id}:sticker`, `k:${id}:emoji`, `k:${id}:print`, `x:${id}`]);

    await send(press(FRIEND, `k:${id}:sticker`, 555));
    const doc = last("sendDocument");
    expect(doc.params.document).toBe("<file sticker.png>");
    expect(String(doc.params.caption)).toContain("<b>Sticker</b> (transparent background kept)");
    expect(buttons(doc)).toEqual([`u:${id}`, `x:${id}`]);
    expect(last("deleteMessage").params.message_id).toBe(555);
    const item = store.item(id);
    expect(item?.status).toBe("ready");
    if (!item) return;
    const meta = await sharp(outputPath(item)).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 1024]);

    calls.length = 0;
    await send(press(FRIEND, `u:${id}`, Number(item.message_id)));
    const alert = last("answerCallbackQuery");
    expect(alert.params.show_alert).toBe(true);
    expect(String(alert.params.text)).toContain("/pair");

    await send(command(FRIEND, "/pair"));
    expect(String(last("sendMessage").params.text)).toMatch(/https:\/\/bot\.example\.invalid\/pair\/[A-Z0-9]{10}/);

    const friend = store.userByTelegramId(FRIEND);
    if (!friend) throw new Error("friend missing");
    store.createDevice(friend.id, "gaming-pc");
    calls.length = 0;
    await send(press(FRIEND, `u:${id}`, Number(item.message_id)));
    expect(last("answerCallbackQuery").params.text).toBe("Queued for upload.");
    expect(String(last("editMessageCaption").params.caption)).toContain("Queued");
    expect(last("editMessageCaption").params.message_id).toBe(item.message_id);

    const claimed = await queue.next(friend.id, 0);
    expect(claimed?.id).toBe(id);
    if (!claimed) return;
    queue.finish(claimed, { ok: true, vrchatId: "file_1" });
    await Bun.sleep(30);
    const done = last("editMessageCaption");
    expect(String(done.params.caption)).toContain("Uploaded to your VRChat account");
    expect(buttons(done)).toEqual([]);
  });

  test("portrait photo as print asks crop or fit and keeps the caption as note", async () => {
    await send(message(FRIEND, {
      photo: [{ file_id: "photos/portrait.jpg", file_unique_id: "p", width: 600, height: 1000 }],
      caption: "beach <night>",
    }));
    const picker = last("sendMessage");
    expect(String(picker.params.text)).toContain("send the image as a file");
    const id = itemIdFrom(picker);
    await send(press(FRIEND, `k:${id}:print`, 600));
    const ask = last("editMessageText");
    expect(String(ask.params.text)).toContain("16:9");
    expect(buttons(ask)).toEqual([`p:${id}:fill`, `p:${id}:fit`, `x:${id}`]);

    await send(press(FRIEND, `p:${id}:fit`, 600));
    const doc = last("sendDocument");
    expect(String(doc.params.caption)).toContain("<b>Print</b>");
    expect(String(doc.params.caption)).toContain("beach &lt;night&gt;");
    const item = store.item(id);
    if (!item) throw new Error("missing");
    const meta = await sharp(outputPath(item)).metadata();
    expect([meta.width, meta.height]).toEqual([1920, 1080]);
  });

  test("animation becomes an animated emoji and asks for an effect before upload", async () => {
    await send(message(FRIEND, {
      animation: { file_id: "animations/clip.mp4", file_unique_id: "a", width: 160, height: 120, duration: 1, mime_type: "video/mp4" },
      document: { file_id: "animations/clip.mp4", file_unique_id: "a", mime_type: "video/mp4" },
    }));
    const doc = last("sendDocument");
    expect(doc.params.document).toBe("<file emoji_10frames_10fps.png>");
    expect(String(doc.params.caption)).toContain("10 frames at 10 fps");
    const keys = buttons(doc);
    expect(keys).toHaveLength(28);
    const id = keys[0]?.split(":")[1] ?? "";

    await send(press(FRIEND, `u:${id}`, 0));
    expect(last("answerCallbackQuery").params.text).toBe("Pick an effect first.");

    await send(press(FRIEND, `a:${id}:3`, 0));
    const edited = last("editMessageCaption");
    expect(String(edited.params.caption)).toContain("effect: bounce");
    expect(buttons(edited)).toEqual([`u:${id}`, `x:${id}`]);
  });

  test("other users can't press someone else's buttons", async () => {
    await send(message(FRIEND, { document: { file_id: "documents/logo.png", file_unique_id: "d", file_name: "logo.png", mime_type: "image/png" } }));
    const id = itemIdFrom(last("sendMessage"));
    store.setAllowed(store.upsertTelegramUser(STRANGER, "Stranger").id, true);
    await send(press(STRANGER, `k:${id}:sticker`, 1));
    expect(last("answerCallbackQuery").params.text).toBe("That item is gone.");
    expect(store.item(id)?.status).toBe("new");

    await send(press(FRIEND, `x:${id}`, 1));
    expect(store.item(id)?.status).toBe("cancelled");
    expect(last("editMessageText").params.text).toBe("Discarded.");
  });

  test("white-background photo offers removal, with undo, and the sticker keeps the cut-out", async () => {
    await send(message(FRIEND, { photo: [{ file_id: "photos/whitebg.jpg", file_unique_id: "w", width: 400, height: 400 }] }));
    const picker = last("sendMessage");
    expect(String(picker.params.text)).toContain("Tap Remove white background");
    const id = itemIdFrom(picker);
    expect(buttons(picker)).toEqual([`k:${id}:sticker`, `k:${id}:emoji`, `k:${id}:print`, `w:${id}`, `x:${id}`]);

    await send(press(FRIEND, `w:${id}`, 700));
    let edited = last("editMessageText");
    expect(String(edited.params.text)).toStartWith("White background removed.");
    expect(buttons(edited)).toContain(`n:${id}`);

    await send(press(FRIEND, `n:${id}`, 700));
    edited = last("editMessageText");
    expect(buttons(edited)).toContain(`w:${id}`);
    expect(store.item(id)?.input_name).toBe("input.jpg");

    await send(press(FRIEND, `w:${id}`, 700));
    await send(press(FRIEND, `k:${id}:sticker`, 700));
    const doc = last("sendDocument");
    expect(String(doc.params.caption)).toContain("(white background removed)");
    const item = store.item(id);
    if (!item) throw new Error("missing");
    const corner = await sharp(outputPath(item)).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(corner[3]).toBe(0);
  });

  test("full inventory shows the oldest item and deletes it only after the user confirms", async () => {
    const friend = store.userByTelegramId(FRIEND);
    if (!friend) throw new Error("missing");
    await send(message(FRIEND, { document: { file_id: "documents/logo.png", file_unique_id: "d", file_name: "logo.png", mime_type: "image/png" } }));
    const id = itemIdFrom(last("sendMessage"));
    await send(press(FRIEND, `k:${id}:sticker`, 800));
    const item = store.item(id);
    if (!item?.message_id) throw new Error("no result message");
    await send(press(FRIEND, `u:${id}`, item.message_id));

    const claimed = await queue.next(friend.id, 0);
    if (!claimed) throw new Error("not claimed");
    await sharp({ create: { width: 64, height: 64, channels: 4, background: "#0f0" } }).png().toFile(join(item.dir, "oldest-preview.png"));
    calls.length = 0;
    queue.finish(claimed, {
      ok: false,
      reason: "full",
      error: "Your VRChat stickers are full (18/18)",
      full: { pool: "sticker", count: 18, limit: 18, oldestId: "file_old", oldestCreatedAt: "2024-01-02T03:04:05.000Z", oldestMine: true },
    });
    await Bun.sleep(50);

    const caption = last("editMessageCaption");
    expect(String(caption.params.caption)).toContain("Your VRChat stickers are full (18/18)");
    expect(String(caption.params.caption)).toContain("from 2 Jan 2024");
    expect(buttons(caption)).toEqual([`d:${id}`, `u:${id}`, `x:${id}`]);
    const preview = last("sendPhoto");
    expect(preview.params.photo).toBe("<file oldest-preview.png>");
    expect(String(preview.params.caption)).toContain("Your oldest sticker, from 2 Jan 2024");
    expect((preview.params.reply_parameters as { message_id?: number }).message_id).toBe(item.message_id);
    expect(store.item(id)?.status).toBe("full");

    await send(press(FRIEND, `d:${id}`, item.message_id));
    const queued = store.item(id);
    expect(queued?.status).toBe("queued");
    expect(JSON.parse(queued?.params ?? "{}").replaceId).toBe("file_old");
    expect(String(last("editMessageCaption").params.caption)).toContain("deletes your oldest sticker");

    const again = await queue.next(friend.id, 0);
    if (!again) throw new Error("not requeued");
    queue.finish(again, { ok: true, vrchatId: "file_new" });
    await Bun.sleep(30);
    expect(String(last("editMessageCaption").params.caption)).toContain("Your oldest sticker was deleted to make room.");
  });

  test("expired companion session sends a DM to the user", async () => {
    const friend = store.userByTelegramId(FRIEND);
    if (!friend) throw new Error("missing");
    const items = store.itemsOlderThan(Date.now() + 1).filter((i) => i.status === "ready" && i.kind === "print");
    const item = items[0];
    if (!item) throw new Error("no ready print");
    queue.enqueue(item.id);
    const claimed = await queue.next(friend.id, 0);
    if (!claimed) throw new Error("not claimed");
    calls.length = 0;
    queue.finish(claimed, { ok: false, reason: "session", error: "VRChat login expired" });
    await Bun.sleep(30);
    const notice = calls.find((c) => c.method === "sendMessage");
    expect(notice?.params.chat_id).toBe(FRIEND);
    expect(String(notice?.params.text)).toContain("login expired");
    expect(store.item(item.id)?.status).toBe("queued");
  });
});

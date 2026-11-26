import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ServerClient, pairDevice, parsePairLink } from "../src/companion/server.ts";
import { processJob } from "../src/companion/uploader.ts";
import { VRChatClient } from "../src/companion/vrchat.ts";
import { startApi } from "../src/server/api.ts";
import { JobQueue, type QueueEvent, outputPath } from "../src/server/jobs.ts";
import { type ItemRow, Store, type UserRow, randomId } from "../src/server/store.ts";

interface Recorded {
  path: string;
  userAgent: string;
  cookie: string;
  fields: Record<string, string>;
  fileName: string;
  fileBytes: number;
}

let dir = "";
let store: Store;
let queue: JobQueue;
let api: ReturnType<typeof startApi>;
let vrc: ReturnType<typeof Bun.serve>;
let user: UserRow;
const events: QueueEvent[] = [];
const uploads: Recorded[] = [];
const mock = { throttleNext: false, expireSession: false, limitError: false };

interface MockEntry {
  id: string;
  createdAt: string;
  authorId?: string;
}
// What the mock VRChat account currently holds, per inventory.
const inventory: Record<"sticker" | "emoji" | "print", MockEntry[]> = { sticker: [], emoji: [], print: [] };
const deleted: string[] = [];
// Cookie header seen by the storage host when a preview is downloaded (must stay empty).
const storageCookies: string[] = [];

function entries(count: number, prefix: string, oldestIndex: number): MockEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i}`,
    createdAt: i === oldestIndex ? "2024-01-02T03:04:05.000Z" : `2026-0${1 + (i % 9)}-1${i % 10}T00:00:00.000Z`,
  }));
}

const CONTACT = "owner@example.invalid";
const UA = `VRCUploadCompanion/0.1.0 ${CONTACT}`;

function cookieMap(header: string | null): Map<string, string> {
  return new Map(
    (header ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((kv): kv is [string, string] => kv.length === 2 && Boolean(kv[0])),
  );
}

async function record(req: Request, path: string, fileField: string): Promise<Recorded> {
  const form = await req.formData();
  const fields: Record<string, string> = {};
  let fileName = "";
  let fileBytes = 0;
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields[key] = value;
    else if (key === fileField) {
      fileName = value.name;
      fileBytes = value.size;
    }
  }
  const rec = {
    path,
    userAgent: req.headers.get("user-agent") ?? "",
    cookie: req.headers.get("cookie") ?? "",
    fields,
    fileName,
    fileBytes,
  };
  uploads.push(rec);
  return rec;
}

function startMockVRChat() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/api/1/auth/user": (req) => {
        const cookies = cookieMap(req.headers.get("cookie"));
        if (cookies.get("auth") === "authcookie_1") {
          if (cookies.get("twoFactorAuth") === "tfa_1") return Response.json({ id: "usr_1", displayName: "Tester" });
          return Response.json({ requiresTwoFactorAuth: ["totp", "otp"] });
        }
        const auth = req.headers.get("authorization") ?? "";
        const expected = `Basic ${btoa(`${encodeURIComponent("me@example.invalid")}:${encodeURIComponent("p@ss word:1")}`)}`;
        if (auth === expected) {
          return Response.json(
            { requiresTwoFactorAuth: ["totp", "otp"] },
            { headers: { "set-cookie": "auth=authcookie_1; Path=/; HttpOnly" } },
          );
        }
        return Response.json({ error: { message: '"Invalid Username/Email or Password"', status_code: 401 } }, { status: 401 });
      },
      "/api/1/auth/twofactorauth/totp/verify": {
        POST: async (req) => {
          const body = (await req.json()) as { code?: string };
          if (body.code !== "123456") return Response.json({ verified: false }, { status: 400 });
          return Response.json({ verified: true }, { headers: { "set-cookie": "twoFactorAuth=tfa_1; Path=/" } });
        },
      },
      "/api/1/file/image": {
        POST: async (req) => {
          if (mock.throttleNext) {
            mock.throttleNext = false;
            return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
          }
          if (mock.expireSession) return Response.json({ error: { message: "Missing Credentials" } }, { status: 401 });
          if (mock.limitError) {
            return Response.json({ error: { message: "You have reached the maximum number of emoji", status_code: 400 } }, { status: 400 });
          }
          await record(req, "/file/image", "file");
          return Response.json({ id: "file_abc" });
        },
      },
      "/api/1/prints": {
        POST: async (req) => {
          await record(req, "/prints", "image");
          return Response.json({ id: "prnt_1" });
        },
      },
      "/api/1/files": (req) => {
        const tag = new URL(req.url).searchParams.get("tag");
        const list = tag === "sticker" || tag === "emoji" ? inventory[tag] : [];
        const base = new URL(req.url).origin;
        return Response.json(
          list.map((e) => ({
            id: e.id,
            tags: [tag],
            versions: [
              { version: 0, status: "complete", created_at: e.createdAt },
              { version: 1, status: "complete", created_at: e.createdAt, file: { url: `${base}/api/1/file/${e.id}/1/file` } },
            ],
          })),
        );
      },
      "/api/1/file/:id": {
        DELETE: (req) => {
          const pool = inventory.sticker.some((e) => e.id === req.params.id) ? inventory.sticker : inventory.emoji;
          const index = pool.findIndex((e) => e.id === req.params.id);
          if (index < 0) return Response.json({ error: { message: "File not found" } }, { status: 404 });
          pool.splice(index, 1);
          deleted.push(req.params.id);
          return Response.json({ id: req.params.id });
        },
      },
      // Real VRChat redirects file downloads to its storage host; "localhost" stands in for that host here.
      "/api/1/file/:id/1/file": (req) =>
        new Response(null, { status: 302, headers: { location: `http://localhost:${new URL(req.url).port}/storage/${req.params.id}.png` } }),
      "/storage/:name": async (req) => {
        storageCookies.push(req.headers.get("cookie") ?? "");
        const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#0f0" } }).png().toBuffer();
        return new Response(png, { headers: { "content-type": "image/png" } });
      },
      "/api/1/prints/user/:userId": (req) =>
        Response.json(
          inventory.print.map((e) => ({
            id: e.id,
            authorId: e.authorId ?? req.params.userId,
            createdAt: e.createdAt,
            files: { image: `${new URL(req.url).origin}/api/1/file/${e.id}/1/file` },
          })),
        ),
      "/api/1/prints/:id": {
        DELETE: (req) => {
          const index = inventory.print.findIndex((e) => e.id === req.params.id);
          if (index < 0) return Response.json({ error: { message: "Print not found" } }, { status: 404 });
          inventory.print.splice(index, 1);
          deleted.push(req.params.id);
          return new Response(null, { status: 200 });
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
}

async function readyItem(kind: ItemRow["kind"], params: Record<string, unknown>): Promise<ItemRow> {
  const id = randomId();
  const itemDir = join(dir, "items", id);
  await mkdir(itemDir, { recursive: true });
  const item = store.createItem({
    id,
    user_id: user.id,
    chat_id: 1,
    source: "still",
    dir: itemDir,
    input_name: "input.png",
    caption: null,
    taken_at: Date.now(),
  });
  await sharp({ create: { width: 128, height: 128, channels: 4, background: "#f0f" } }).png().toFile(outputPath(item));
  return store.updateItem(id, { kind, params: JSON.stringify(params), status: "ready" });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vrc-flow-"));
  store = new Store(join(dir, "test.sqlite"));
  queue = new JobQueue(store);
  queue.onEvent((e) => events.push(e));
  api = startApi({ config: { host: "127.0.0.1", port: 0, vrchatContact: CONTACT, distDir: dir }, store, queue });
  vrc = startMockVRChat();
  user = store.upsertTelegramUser(4242, "Friend");
  store.setAllowed(user.id, true);
});

afterAll(async () => {
  await api.stop(true);
  await vrc.stop(true);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("pairing", () => {
  test("parses pairing links, including servers under a subpath", () => {
    expect(parsePairLink("https://bot.example.com/pair/ABCD234567")).toEqual({
      serverUrl: "https://bot.example.com",
      code: "ABCD234567",
    });
    expect(parsePairLink(" https://example.com/vrc/pair/XYZ ")).toEqual({
      serverUrl: "https://example.com/vrc",
      code: "XYZ",
    });
    expect(() => parsePairLink("ABCD")).toThrow();
  });

  test("pair codes are single use and rejected for unknown devices", async () => {
    const code = store.createPairCode(user.id);
    const link = `${api.url.origin}/pair/${code}`;
    const paired = await pairDevice(link, "test-pc");
    expect(paired.contact).toBe(CONTACT);
    expect(paired.userName).toBe("Friend");
    await expect(pairDevice(link, "again")).rejects.toThrow(/invalid or expired/);
    const anon = await fetch(`${api.url.origin}/api/me`);
    expect(anon.status).toBe(401);
    const page = await fetch(link);
    expect(page.headers.get("content-type")).toContain("text/html");
  });
});

describe("upload flow", () => {
  let server: ServerClient;
  let vrchat: VRChatClient;

  beforeAll(async () => {
    const code = store.createPairCode(user.id);
    const paired = await pairDevice(`${api.url.origin}/pair/${code}`, "gaming-pc");
    server = new ServerClient(paired.serverUrl, paired.token);
    vrchat = new VRChatClient(UA, {}, `${vrc.url.origin}/api/1`);
  });

  test("VRChat login with 2FA keeps only session cookies", async () => {
    await expect(vrchat.login("me@example.invalid", "wrong")).rejects.toThrow(/Invalid Username/);
    const first = await vrchat.login("me@example.invalid", "p@ss word:1");
    expect(first).toEqual({ status: "2fa", methods: ["totp", "otp"] });
    expect(await vrchat.verifyTwoFactor("totp", "000000")).toBe(false);
    expect(await vrchat.verifyTwoFactor("totp", "123456")).toBe(true);
    expect(await vrchat.currentUser()).toEqual({ id: "usr_1", displayName: "Tester" });
    expect(vrchat.cookieRecord()).toEqual({ auth: "authcookie_1", twoFactorAuth: "tfa_1" });
  });

  test("long poll wakes on enqueue and uploads an animated emoji", async () => {
    const item = await readyItem("emojianimated", { frames: 4, fps: 8, animationStyle: "bounce" });
    const pending = server.next(5);
    await Bun.sleep(50);
    queue.enqueue(item.id);
    const job = await pending;
    expect(job).not.toBeNull();
    if (!job) return;
    expect(job.kind).toBe("emojianimated");
    expect(job.fileName).toBe("emoji_4frames_8fps.png");
    expect(store.item(item.id)?.status).toBe("uploading");

    mock.throttleNext = true;
    const result = await processJob(job, server, vrchat);
    expect(result).toEqual({ ok: true, vrchatId: "file_abc" });
    await server.report(job.id, result);

    const rec = uploads.at(-1);
    expect(rec?.path).toBe("/file/image");
    expect(rec?.fields).toEqual({
      tag: "emojianimated",
      animationStyle: "bounce",
      frames: "4",
      framesOverTime: "8",
      loopStyle: "linear",
    });
    expect(rec?.fileName).toBe("emoji_4frames_8fps.png");
    expect(rec?.fileBytes).toBeGreaterThan(0);
    expect(rec?.userAgent).toBe(UA);
    expect(rec?.cookie).toContain("auth=authcookie_1");
    expect(rec?.cookie).toContain("twoFactorAuth=tfa_1");

    const final = store.item(item.id);
    expect(final?.status).toBe("done");
    expect(final?.vrchat_id).toBe("file_abc");
    const statuses = events.filter((e) => e.type === "item" && e.item.id === item.id).map((e) => (e.type === "item" ? e.item.status : ""));
    expect(statuses).toEqual(["queued", "uploading", "done"]);
  }, 15_000);

  test("sticker and print use the right endpoints and fields", async () => {
    const sticker = await readyItem("sticker", {});
    queue.enqueue(sticker.id);
    const stickerJob = await server.next(1);
    if (!stickerJob) throw new Error("no sticker job");
    await server.report(stickerJob.id, await processJob(stickerJob, server, vrchat));
    expect(uploads.at(-1)?.fields).toEqual({ tag: "sticker" });

    const takenAt = "2026-11-20T18:30:00.000Z";
    const print = await readyItem("print", { note: "fun night", takenAt });
    queue.enqueue(print.id);
    const printJob = await server.next(1);
    if (!printJob) throw new Error("no print job");
    const result = await processJob(printJob, server, vrchat);
    expect(result).toEqual({ ok: true, vrchatId: "prnt_1" });
    await server.report(printJob.id, result);
    const rec = uploads.at(-1);
    expect(rec?.path).toBe("/prints");
    expect(rec?.fields).toEqual({ timestamp: takenAt, note: "fun night" });
    expect(rec?.fileName).toBe("print.png");
  });

  test("expired VRChat session requeues the job and notifies", async () => {
    const item = await readyItem("emoji", { animationStyle: "spin" });
    queue.enqueue(item.id);
    const job = await server.next(1);
    if (!job) throw new Error("no job");
    mock.expireSession = true;
    const result = await processJob(job, server, vrchat);
    mock.expireSession = false;
    expect(result).toEqual({ ok: false, reason: "session", error: "VRChat login expired" });
    await server.report(job.id, result);
    expect(store.item(item.id)?.status).toBe("queued");
    expect(events.some((e) => e.type === "session-expired" && e.userId === user.id)).toBe(true);

    const retry = await server.next(1);
    expect(retry?.id).toBe(item.id);
    await server.report(item.id, await processJob(retry ?? job, server, vrchat));
    expect(store.item(item.id)?.status).toBe("done");
  });

  test("empty queue returns null after the wait, revoked users are locked out", async () => {
    const started = Date.now();
    expect(await server.next(1)).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    store.setAllowed(user.id, false);
    await expect(server.next(0)).rejects.toThrow(/revoked/);
    store.setAllowed(user.id, true);
  });

  test("another user's device can't touch the job", async () => {
    const other = store.upsertTelegramUser(777, "Stranger");
    store.setAllowed(other.id, true);
    const code = store.createPairCode(other.id);
    const paired = await pairDevice(`${api.url.origin}/pair/${code}`, "stranger-pc");
    const strangerServer = new ServerClient(paired.serverUrl, paired.token);

    const item = await readyItem("sticker", {});
    queue.enqueue(item.id);
    expect(await strangerServer.next(0)).toBeNull();
    const job = await server.next(1);
    if (!job) throw new Error("no job");
    await expect(strangerServer.file(job.id)).rejects.toThrow(/No such job/);
    await expect(strangerServer.report(job.id, { ok: true, vrchatId: "x" })).rejects.toThrow(/No such job/);
    await server.report(job.id, { ok: false, reason: "other", error: "test" });
    expect(store.item(item.id)?.status).toBe("failed");
  });
});

describe("full inventory", () => {
  let server: ServerClient;
  let vrchat: VRChatClient;

  beforeAll(async () => {
    const code = store.createPairCode(user.id);
    const paired = await pairDevice(`${api.url.origin}/pair/${code}`, "full-pc");
    server = new ServerClient(paired.serverUrl, paired.token);
    vrchat = new VRChatClient(UA, { auth: "authcookie_1", twoFactorAuth: "tfa_1" }, `${vrc.url.origin}/api/1`);
  });

  async function claim(item: ItemRow) {
    queue.enqueue(item.id);
    const job = await server.next(1);
    if (!job || job.id !== item.id) throw new Error("job not claimed");
    return job;
  }

  test("18 stickers: offers the oldest with a preview, deletes exactly that one after confirmation", async () => {
    inventory.sticker = entries(18, "file_s", 7);
    const uploadsBefore = uploads.length;
    const item = await readyItem("sticker", {});
    const job = await claim(item);

    const result = await processJob(job, server, vrchat);
    expect(result).toEqual({
      ok: false,
      reason: "full",
      error: "Your VRChat stickers are full (18/18)",
      full: { pool: "sticker", count: 18, limit: 18, oldestId: "file_s_7", oldestCreatedAt: "2024-01-02T03:04:05.000Z", oldestMine: true },
    });
    expect(uploads.length).toBe(uploadsBefore);
    expect(deleted).toEqual([]);
    expect(storageCookies.at(-1)).toBe("");
    expect(await Bun.file(join(item.dir, "oldest-preview.png")).exists()).toBe(true);

    await server.report(job.id, result);
    const full = store.item(item.id);
    expect(full?.status).toBe("full");
    expect(events.some((e) => e.type === "full" && e.item.id === item.id && e.offer.oldestId === "file_s_7")).toBe(true);

    // The user taps "Delete oldest sticker and upload": the bot sets replaceId to the offered item.
    store.updateItem(item.id, { params: JSON.stringify({ replaceId: "file_s_7" }) });
    const confirmed = await claim(item);
    const done = await processJob(confirmed, server, vrchat);
    expect(done).toEqual({ ok: true, vrchatId: "file_abc" });
    expect(deleted).toEqual(["file_s_7"]);
    expect(inventory.sticker).toHaveLength(17);
    expect(uploads.at(-1)?.fields.tag).toBe("sticker");
    await server.report(confirmed.id, done);
    expect(store.item(item.id)?.status).toBe("done");
  });

  test("animated emoji count toward the emoji slots; a limit error from VRChat also counts as full", async () => {
    inventory.emoji = entries(18, "file_e", 0);
    const item = await readyItem("emojianimated", { frames: 4, fps: 8, animationStyle: "spin" });
    const job = await claim(item);
    const result = await processJob(job, server, vrchat);
    expect(result.ok === false && result.full?.pool).toBe("emoji");
    await server.report(job.id, result);

    inventory.emoji = entries(5, "file_f", 2);
    mock.limitError = true;
    const item2 = await readyItem("emoji", { animationStyle: "spin" });
    const job2 = await claim(item2);
    const result2 = await processJob(job2, server, vrchat);
    mock.limitError = false;
    expect(result2.ok === false && result2.reason).toBe("full");
    expect(result2.ok === false && result2.full?.oldestId).toBe("file_f_2");
    expect(result2.ok === false && result2.full?.limit).toBe(18);
    await server.report(job2.id, result2);
  });

  test("prints: the oldest can be a print saved from someone else", async () => {
    inventory.print = entries(64, "prnt_p", 3);
    const oldest = inventory.print[3];
    if (oldest) oldest.authorId = "usr_someone_else";
    const item = await readyItem("print", { takenAt: "2026-11-20T18:30:00.000Z" });
    const job = await claim(item);
    const result = await processJob(job, server, vrchat);
    expect(result.ok === false && result.full).toEqual({
      pool: "print",
      count: 64,
      limit: 64,
      oldestId: "prnt_p_3",
      oldestCreatedAt: "2024-01-02T03:04:05.000Z",
      oldestMine: false,
    });
    await server.report(job.id, result);

    store.updateItem(item.id, { params: JSON.stringify({ takenAt: "2026-11-20T18:30:00.000Z", replaceId: "prnt_p_3" }) });
    const confirmed = await claim(item);
    expect(await processJob(confirmed, server, vrchat)).toEqual({ ok: true, vrchatId: "prnt_1" });
    expect(deleted.at(-1)).toBe("prnt_p_3");
    await server.report(confirmed.id, { ok: true, vrchatId: "prnt_1" });
  });

  test("the preview endpoint only accepts images for the device's own claimed job", async () => {
    const item = await readyItem("sticker", {});
    const res = await fetch(`${api.url.origin}/api/jobs/${item.id}/preview`, { method: "POST", body: "x" });
    expect(res.status).toBe(401);
    inventory.sticker = [];
    const job = await claim(item);
    await expect(server.uploadPreview(job.id, new Blob(["not an image"]))).rejects.toThrow(/PNG, JPEG or WebP/);
    await server.report(job.id, await processJob(job, server, vrchat));
  });
});

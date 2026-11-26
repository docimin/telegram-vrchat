import { join } from "node:path";
import { JobResult, PairRequest } from "../shared/protocol.ts";
import type { Config } from "./config.ts";
import { type JobQueue, outputPath, previewExtension, toJob } from "./jobs.ts";
import { logError } from "./log.ts";
import type { DeviceRow, Store } from "./store.ts";

export interface ApiDeps {
  config: Pick<Config, "host" | "port" | "vrchatContact" | "distDir">;
  store: Store;
  queue: JobQueue;
}

const MAX_WAIT_SECONDS = 30;
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

export const COMPANION_BUILDS = {
  windows: "vrc-companion-windows.exe",
  linux: "vrc-companion-linux",
  macos: "vrc-companion-macos",
} as const;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

// Small fixed-window limiter so pairing codes can't be brute forced.
class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt < now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt < now) this.hits.delete(key);
  }
}

const PAIR_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair companion</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fafafa}
@media (prefers-color-scheme: dark){body{color:#eee;background:#151515}}</style></head>
<body><h1>Almost there</h1><p>This is a pairing link for the VRChat upload companion.
Copy the link from Telegram and paste it into the companion app when it asks for it.</p></body></html>`;

export function startApi(deps: ApiDeps) {
  const { config, store, queue } = deps;
  const pairLimiter = new RateLimiter(10, 10 * 60 * 1000);

  const authenticate = (req: Request): DeviceRow | null => {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match?.[1] ? store.deviceByToken(match[1]) : null;
  };

  const ownedItem = (device: DeviceRow, id: string) => {
    const item = store.item(id);
    return item && item.user_id === device.user_id ? item : null;
  };

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    // Long polls hold requests for up to 30s.
    idleTimeout: 60,
    routes: {
      "/health": new Response("ok"),

      "/pair/:code": () => new Response(PAIR_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } }),

      "/api/pair": {
        POST: async (req, srv) => {
          const ip = srv.requestIP(req)?.address ?? "unknown";
          if (!pairLimiter.allow(ip)) return error(429, "Too many pairing attempts, try again later");
          const body = PairRequest.safeParse(await req.json().catch(() => null));
          if (!body.success) return error(400, "Invalid pairing request");
          const userId = store.consumePairCode(body.data.code);
          const user = userId === null ? null : store.userById(userId);
          if (!user || !user.allowed) return error(404, "Pairing code is invalid or expired, ask the bot for a new one with /pair");
          const token = store.createDevice(user.id, body.data.deviceName);
          return json({ token, userName: user.name, contact: config.vrchatContact });
        },
      },

      "/api/me": {
        GET: (req) => {
          const device = authenticate(req);
          if (!device) return error(401, "Unknown device, pair again");
          const user = store.userById(device.user_id);
          if (!user?.allowed) return error(403, "Your access to the bot was revoked");
          return json({ userName: user.name, deviceName: device.name, queued: store.queuedCount(user.id) });
        },
      },

      "/api/jobs/next": {
        GET: async (req) => {
          const device = authenticate(req);
          if (!device) return error(401, "Unknown device, pair again");
          if (!store.userById(device.user_id)?.allowed) return error(403, "Your access to the bot was revoked");
          const wait = Number(new URL(req.url).searchParams.get("wait") ?? "0");
          const waitMs = Math.max(0, Math.min(MAX_WAIT_SECONDS, Number.isFinite(wait) ? wait : 0)) * 1000;
          const item = await queue.next(device.user_id, waitMs, req.signal);
          if (!item) return new Response(null, { status: 204 });
          return json({ job: toJob(item) });
        },
      },

      "/api/jobs/:id/file": {
        GET: (req) => {
          const device = authenticate(req);
          if (!device) return error(401, "Unknown device, pair again");
          const item = ownedItem(device, req.params.id);
          if (!item || item.status !== "uploading") return error(404, "No such job");
          return new Response(Bun.file(outputPath(item)), { headers: { "content-type": "image/png" } });
        },
      },

      "/api/jobs/:id/preview": {
        POST: async (req) => {
          const device = authenticate(req);
          if (!device) return error(401, "Unknown device, pair again");
          const item = ownedItem(device, req.params.id);
          if (!item || item.status !== "uploading") return error(404, "No such job");
          const declared = Number(req.headers.get("content-length") ?? "0");
          if (declared > MAX_PREVIEW_BYTES) return error(413, "Preview too large");
          const bytes = new Uint8Array(await req.arrayBuffer());
          if (bytes.length === 0 || bytes.length > MAX_PREVIEW_BYTES) return error(413, "Preview too large");
          const ext = previewExtension(bytes);
          if (!ext) return error(415, "Preview must be PNG, JPEG or WebP");
          await Bun.write(join(item.dir, `oldest-preview.${ext}`), bytes);
          return json({ ok: true });
        },
      },

      "/api/jobs/:id/result": {
        POST: async (req) => {
          const device = authenticate(req);
          if (!device) return error(401, "Unknown device, pair again");
          const item = ownedItem(device, req.params.id);
          if (!item || item.status !== "uploading") return error(404, "No such job");
          const body = JobResult.safeParse(await req.json().catch(() => null));
          if (!body.success) return error(400, "Invalid result");
          queue.finish(item, body.data);
          return json({ ok: true });
        },
      },

      "/download/:platform": async (req) => {
        const platform = req.params.platform;
        if (!(platform in COMPANION_BUILDS)) return error(404, "Unknown platform");
        const name = COMPANION_BUILDS[platform as keyof typeof COMPANION_BUILDS];
        const file = Bun.file(join(config.distDir, name));
        if (!(await file.exists())) return error(404, "Companion build not found on this server");
        return new Response(file, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${name}"`,
          },
        });
      },
    },
    fetch: () => error(404, "Not found"),
    error: (err) => {
      logError("API error:", err);
      return error(500, "Internal error");
    },
  });

  return server;
}

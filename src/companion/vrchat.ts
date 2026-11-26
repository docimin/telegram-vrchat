import { z } from "zod";

// Minimal VRChat API client, based on the community docs at https://vrchat.community.
// Runs on the user's own machine with their own session, as VRChat's API guidelines require.

const DEFAULT_BASE = "https://api.vrchat.cloud/api/1";

export type TwoFactorMethod = "totp" | "otp" | "emailOtp";

const TWO_FACTOR_PATHS: Record<TwoFactorMethod, string> = {
  totp: "/auth/twofactorauth/totp/verify",
  otp: "/auth/twofactorauth/otp/verify",
  emailOtp: "/auth/twofactorauth/emailotp/verify",
};

const CurrentUser = z.object({ id: z.string(), displayName: z.string() });
export type CurrentUser = z.infer<typeof CurrentUser>;

const NeedsTwoFactor = z.object({ requiresTwoFactorAuth: z.array(z.string()) });
const Verified = z.object({ verified: z.boolean() });
const Created = z.object({ id: z.string() });
const ApiErrorBody = z.object({ error: z.object({ message: z.string().optional() }) });

export class VRChatApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// The session is missing or expired: the user has to log in again.
export class VRChatAuthError extends VRChatApiError {}

export type LoginResult =
  | { status: "ok"; user: CurrentUser }
  | { status: "2fa"; methods: TwoFactorMethod[] };

const MAX_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = ApiErrorBody.safeParse(JSON.parse(text));
    if (parsed.success && parsed.data.error.message) return parsed.data.error.message.replace(/^"|"$/g, "");
  } catch {
    // Not JSON.
  }
  return text.slice(0, 200) || `HTTP ${res.status}`;
}

export interface InventoryEntry {
  id: string;
  createdAt: string;
  imageUrl: string | undefined;
  mine: boolean;
}

const FileList = z.array(
  z.object({
    id: z.string(),
    versions: z.array(
      z.object({
        created_at: z.string().optional(),
        file: z.object({ url: z.string() }).optional(),
      }),
    ),
  }),
);

const PrintList = z.array(
  z.object({
    id: z.string(),
    authorId: z.string().optional(),
    createdAt: z.string().optional(),
    timestamp: z.string().optional(),
    files: z.object({ image: z.string().optional() }).optional(),
  }),
);

const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

export class VRChatClient {
  readonly cookies: Map<string, string>;
  private readonly base: string;
  private cachedUserId: string | undefined;

  constructor(
    private readonly userAgent: string,
    cookies: Record<string, string> = {},
    base: string = process.env.VRCHAT_API_BASE ?? DEFAULT_BASE,
  ) {
    this.cookies = new Map(Object.entries(cookies));
    this.base = base.replace(/\/+$/, "");
  }

  cookieRecord(): Record<string, string> {
    return Object.fromEntries(this.cookies);
  }

  private storeCookies(res: Response): void {
    for (const header of res.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = /max-age=0|expires=thu, 01 jan 1970/i.test(header);
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  // One request with backoff on 429 / 5xx, as the API guidelines ask.
  private async request(method: string, path: string, init: { headers?: Record<string, string>; body?: RequestInit["body"] } = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { "User-Agent": this.userAgent, ...init.headers };
      if (this.cookies.size) {
        headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      }
      const res = await fetch(`${this.base}${path}`, { method, headers, body: init.body });
      this.storeCookies(res);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) return res;
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = 1000 * 2 ** attempt;
      const wait = Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 0, backoff) + Math.random() * 500;
      await res.body?.cancel();
      await sleep(wait);
    }
  }

  private async expectOk(res: Response): Promise<Response> {
    if (res.ok) return res;
    const message = await errorMessage(res);
    if (res.status === 401) throw new VRChatAuthError(401, message);
    throw new VRChatApiError(res.status, message);
  }

  async login(username: string, password: string): Promise<LoginResult> {
    this.cookies.clear();
    const basic = btoa(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`);
    const res = await this.expectOk(
      await this.request("GET", "/auth/user", { headers: { Authorization: `Basic ${basic}` } }),
    );
    const body: unknown = await res.json();
    const twoFactor = NeedsTwoFactor.safeParse(body);
    if (twoFactor.success) {
      const methods = twoFactor.data.requiresTwoFactorAuth.filter(
        (m): m is TwoFactorMethod => m === "totp" || m === "otp" || m === "emailOtp",
      );
      return { status: "2fa", methods };
    }
    return { status: "ok", user: CurrentUser.parse(body) };
  }

  async verifyTwoFactor(method: TwoFactorMethod, code: string): Promise<boolean> {
    const res = await this.request("POST", TWO_FACTOR_PATHS[method], {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.status === 400 || res.status === 401) return false;
    await this.expectOk(res);
    return Verified.parse(await res.json()).verified;
  }

  // Returns null when there is no usable session.
  async currentUser(): Promise<CurrentUser | null> {
    if (!this.cookies.has("auth")) return null;
    const res = await this.request("GET", "/auth/user");
    if (res.status === 401) return null;
    await this.expectOk(res);
    const parsed = CurrentUser.safeParse(await res.json());
    if (!parsed.success) return null;
    this.cachedUserId = parsed.data.id;
    return parsed.data;
  }

  async logout(): Promise<void> {
    const res = await this.request("PUT", "/logout");
    await res.body?.cancel();
    this.cookies.clear();
  }

  private async upload(path: string, fileField: string, file: Blob, fileName: string, fields: Record<string, string>): Promise<string> {
    const form = new FormData();
    form.append(fileField, file, fileName);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const res = await this.expectOk(await this.request("POST", path, { body: form }));
    return Created.parse(await res.json()).id;
  }

  // Stickers, emoji and animated emoji (POST /file/image).
  uploadImage(file: Blob, fileName: string, fields: Record<string, string>): Promise<string> {
    return this.upload("/file/image", "file", file, fileName, fields);
  }

  // Prints (POST /prints).
  uploadPrint(file: Blob, fileName: string, fields: Record<string, string>): Promise<string> {
    return this.upload("/prints", "image", file, fileName, fields);
  }

  private async userId(): Promise<string> {
    if (this.cachedUserId) return this.cachedUserId;
    const user = await this.currentUser();
    if (!user) throw new VRChatAuthError(401, "Not logged in");
    return user.id;
  }

  // Own stickers ("sticker") or emoji ("emoji", which includes animated emoji).
  async listFiles(tag: "sticker" | "emoji"): Promise<InventoryEntry[]> {
    const res = await this.expectOk(await this.request("GET", `/files?tag=${tag}&n=100`));
    return FileList.parse(await res.json()).map((file) => {
      const latest = file.versions.filter((v) => v.file?.url).at(-1);
      return {
        id: file.id,
        createdAt: file.versions[0]?.created_at ?? "",
        imageUrl: latest?.file?.url,
        mine: true,
      };
    });
  }

  // All prints in the user's inventory, including ones saved from other people.
  async listPrints(): Promise<InventoryEntry[]> {
    const userId = await this.userId();
    const res = await this.expectOk(await this.request("GET", `/prints/user/${encodeURIComponent(userId)}`));
    return PrintList.parse(await res.json()).map((print) => ({
      id: print.id,
      createdAt: print.createdAt ?? print.timestamp ?? "",
      imageUrl: print.files?.image,
      mine: print.authorId === undefined || print.authorId === userId,
    }));
  }

  // Deleting something that is already gone counts as success.
  async deleteFile(fileId: string): Promise<void> {
    const res = await this.request("DELETE", `/file/${encodeURIComponent(fileId)}`);
    if (res.status === 404) return void (await res.body?.cancel());
    await this.expectOk(res);
    await res.body?.cancel();
  }

  async deletePrint(printId: string): Promise<void> {
    const res = await this.request("DELETE", `/prints/${encodeURIComponent(printId)}`);
    if (res.status === 404) return void (await res.body?.cancel());
    await this.expectOk(res);
    await res.body?.cancel();
  }

  // Fetch an inventory image for a preview. The session cookie only goes to the API host;
  // redirects (to VRChat's file storage) are followed without it. Returns null on any failure.
  async downloadImage(url: string): Promise<Blob | null> {
    try {
      const target = new URL(url);
      const headers: Record<string, string> = { "User-Agent": this.userAgent };
      if (target.host === new URL(this.base).host && this.cookies.size) {
        headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      }
      let res = await fetch(target, { headers, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) return null;
        res = await fetch(new URL(location, target), { headers: { "User-Agent": this.userAgent } });
      }
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const blob = await res.blob();
      return blob.size > 0 && blob.size <= MAX_PREVIEW_BYTES ? blob : null;
    } catch {
      return null;
    }
  }
}

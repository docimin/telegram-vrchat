import { z } from "zod";
import {
  type Job,
  type JobResult,
  MeResponse,
  NextJobResponse,
  PAIR_PATH,
  PairResponse,
} from "../shared/protocol.ts";

const ErrorBody = z.object({ error: z.string() });

export class ServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function failure(res: Response): Promise<ServerError> {
  const text = await res.text().catch(() => "");
  let message = text.slice(0, 200) || `HTTP ${res.status}`;
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(text));
    if (parsed.success) message = parsed.data.error;
  } catch {
    // Not JSON.
  }
  return new ServerError(res.status, message);
}

// "https://bot.example.com/pair/ABCD234567" -> server URL and code.
export function parsePairLink(link: string): { serverUrl: string; code: string } {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error("That doesn't look like a pairing link. Copy the whole link from the bot's /pair message.");
  }
  const at = url.pathname.lastIndexOf(PAIR_PATH);
  const code = at >= 0 ? url.pathname.slice(at + PAIR_PATH.length).replace(/\/+$/, "") : "";
  if (!code || code.includes("/")) {
    throw new Error("That link has no pairing code. Copy the whole link from the bot's /pair message.");
  }
  return { serverUrl: `${url.origin}${url.pathname.slice(0, at)}`, code };
}

export async function pairDevice(link: string, deviceName: string): Promise<PairResponse & { serverUrl: string }> {
  const { serverUrl, code } = parsePairLink(link);
  const res = await fetch(`${serverUrl}/api/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceName }),
  });
  if (!res.ok) throw await failure(res);
  return { ...PairResponse.parse(await res.json()), serverUrl };
}

export class ServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw await failure(res);
    return res;
  }

  async me(): Promise<z.infer<typeof MeResponse>> {
    return MeResponse.parse(await (await this.call("/api/me")).json());
  }

  async next(waitSeconds: number, signal?: AbortSignal): Promise<Job | null> {
    const res = await this.call(`/api/jobs/next?wait=${waitSeconds}`, { signal });
    if (res.status === 204) return null;
    return NextJobResponse.parse(await res.json()).job;
  }

  async file(jobId: string): Promise<Blob> {
    const res = await this.call(`/api/jobs/${encodeURIComponent(jobId)}/file`);
    return new Blob([await res.arrayBuffer()], { type: "image/png" });
  }

  async report(jobId: string, result: JobResult): Promise<void> {
    await this.call(`/api/jobs/${encodeURIComponent(jobId)}/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    });
  }
}

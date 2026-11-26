import { existsSync } from "node:fs";
import { join } from "node:path";
import { animatedFileName } from "../shared/formats.ts";
import { InventoryFull, type Job, JobParams, type JobResult } from "../shared/protocol.ts";
import { logError } from "./log.ts";
import type { ItemRow, Store } from "./store.ts";

export type QueueEvent =
  | { type: "item"; item: ItemRow }
  | { type: "full"; item: ItemRow; offer: InventoryFull }
  | { type: "session-expired"; userId: number };

const PREVIEW_TYPES = [
  { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
] as const;

// Identify an uploaded preview image by its first bytes; anything else is rejected.
export function previewExtension(bytes: Uint8Array): string | null {
  const type = PREVIEW_TYPES.find((t) => t.magic.every((b, i) => bytes[i] === b));
  return type?.ext ?? null;
}

export function previewPath(item: ItemRow): string | null {
  for (const { ext } of PREVIEW_TYPES) {
    const path = join(item.dir, `oldest-preview.${ext}`);
    if (existsSync(path)) return path;
  }
  return null;
}

export function itemOffer(item: ItemRow): InventoryFull | null {
  if (!item.offer) return null;
  const parsed = InventoryFull.safeParse(JSON.parse(item.offer));
  return parsed.success ? parsed.data : null;
}

const STALE_CLAIM_MS = 10 * 60 * 1000;

export const OUTPUT_NAME = "output.png";

export function outputPath(item: ItemRow): string {
  return join(item.dir, OUTPUT_NAME);
}

export function inputPath(item: ItemRow): string {
  return join(item.dir, item.input_name);
}

export function itemParams(item: ItemRow): JobParams {
  const parsed = JobParams.safeParse(JSON.parse(item.params));
  return parsed.success ? parsed.data : {};
}

export function uploadFileName(item: ItemRow): string {
  const params = itemParams(item);
  if (item.kind === "emojianimated" && params.frames && params.fps) {
    return animatedFileName(params.frames, params.fps);
  }
  return `${item.kind ?? "image"}.png`;
}

export function toJob(item: ItemRow): Job {
  if (!item.kind) throw new Error(`Item ${item.id} has no kind`);
  return { id: item.id, kind: item.kind, params: itemParams(item), fileName: uploadFileName(item) };
}

// Upload queue shared by every chat platform. Companions long-poll it, chat adapters listen for changes.
export class JobQueue {
  private readonly waiters = new Map<number, Set<() => void>>();
  private readonly listeners = new Set<(event: QueueEvent) => void>();

  constructor(private readonly store: Store) {}

  onEvent(listener: (event: QueueEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: QueueEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logError("Queue listener failed:", err);
      }
    }
  }

  private wake(userId: number): void {
    const set = this.waiters.get(userId);
    if (!set) return;
    this.waiters.delete(userId);
    for (const resolve of set) resolve();
  }

  enqueue(itemId: string): ItemRow {
    const item = this.store.updateItem(itemId, { status: "queued", error: null, claimed_at: null });
    this.emit({ type: "item", item });
    this.wake(item.user_id);
    return item;
  }

  cancel(itemId: string): ItemRow {
    const item = this.store.updateItem(itemId, { status: "cancelled" });
    this.emit({ type: "item", item });
    return item;
  }

  // Wait up to waitMs for a queued item and claim it for the calling companion.
  async next(userId: number, waitMs: number, signal?: AbortSignal): Promise<ItemRow | null> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      for (const stale of this.store.requeueStale(STALE_CLAIM_MS)) {
        this.emit({ type: "item", item: stale });
      }
      const item = this.store.claimNext(userId);
      if (item) {
        this.emit({ type: "item", item });
        return item;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || signal?.aborted) return null;
      await this.waitForWork(userId, remaining, signal);
    }
  }

  private waitForWork(userId: number, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiters.get(userId);
      if (!set) {
        set = new Set();
        this.waiters.set(userId, set);
      }
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.waiters.get(userId)?.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      set.add(done);
    });
  }

  finish(item: ItemRow, result: JobResult): ItemRow {
    if (result.ok) {
      const updated = this.store.updateItem(item.id, {
        status: "done",
        vrchat_id: result.vrchatId,
        error: null,
        claimed_at: null,
      });
      this.emit({ type: "item", item: updated });
      return updated;
    }
    if (result.reason === "full" && result.full) {
      const updated = this.store.updateItem(item.id, {
        status: "full",
        offer: JSON.stringify(result.full),
        error: result.error,
        claimed_at: null,
      });
      this.emit({ type: "item", item: updated });
      this.emit({ type: "full", item: updated, offer: result.full });
      return updated;
    }
    if (result.reason === "session") {
      // Keep the item queued; it uploads once the friend logs in to VRChat again in the companion.
      const updated = this.store.updateItem(item.id, { status: "queued", claimed_at: null, error: null });
      this.emit({ type: "session-expired", userId: item.user_id });
      this.emit({ type: "item", item: updated });
      return updated;
    }
    const updated = this.store.updateItem(item.id, {
      status: "failed",
      error: result.error,
      claimed_at: null,
    });
    this.emit({ type: "item", item: updated });
    return updated;
  }
}

import { INVENTORY_LIMITS, POOL_NAMES, poolFor } from "../shared/formats.ts";
import type { InventoryFull, InventoryPool, Job, JobResult } from "../shared/protocol.ts";
import type { ServerClient } from "./server.ts";
import { type InventoryEntry, VRChatApiError, VRChatAuthError, type VRChatClient } from "./vrchat.ts";

export function uploadFields(job: Job): Record<string, string> {
  const p = job.params;
  const fields: Record<string, string> = {};
  switch (job.kind) {
    case "sticker":
      fields.tag = "sticker";
      break;
    case "emoji":
      fields.tag = "emoji";
      if (p.animationStyle) fields.animationStyle = p.animationStyle;
      break;
    case "emojianimated":
      fields.tag = "emojianimated";
      if (p.animationStyle) fields.animationStyle = p.animationStyle;
      fields.frames = String(p.frames ?? 2);
      fields.framesOverTime = String(p.fps ?? 10);
      fields.loopStyle = "linear";
      break;
    case "print":
      fields.timestamp = p.takenAt ?? new Date().toISOString();
      if (p.note) fields.note = p.note;
      break;
  }
  return fields;
}

// VRChat's wording for a full inventory isn't documented; match the likely phrasings.
const LIMIT_ERROR = /limit|maximum|too many|full|max(imum)? (number|amount)/i;

function listPool(vrchat: VRChatClient, pool: InventoryPool): Promise<InventoryEntry[]> {
  return pool === "print" ? vrchat.listPrints() : vrchat.listFiles(pool);
}

function deleteFromPool(vrchat: VRChatClient, pool: InventoryPool, id: string): Promise<void> {
  return pool === "print" ? vrchat.deletePrint(id) : vrchat.deleteFile(id);
}

// When the pool has no free slot, describe its oldest item (and send a preview of it to the bot).
async function fullInventory(
  job: Job,
  pool: InventoryPool,
  server: ServerClient,
  vrchat: VRChatClient,
  force: boolean,
): Promise<JobResult | null> {
  const entries = await listPool(vrchat, pool);
  const limit = INVENTORY_LIMITS[pool];
  if (entries.length === 0 || (!force && entries.length < limit)) return null;
  const oldest = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  if (!oldest) return null;
  if (oldest.imageUrl) {
    const preview = await vrchat.downloadImage(oldest.imageUrl);
    if (preview) await server.uploadPreview(job.id, preview).catch(() => undefined);
  }
  const full: InventoryFull = {
    pool,
    count: entries.length,
    limit: Math.max(limit, entries.length),
    oldestId: oldest.id,
    oldestCreatedAt: oldest.createdAt,
    oldestMine: oldest.mine,
  };
  return {
    ok: false,
    reason: "full",
    error: `Your VRChat ${POOL_NAMES[pool].many} are full (${full.count}/${full.limit})`,
    full,
  };
}

// Download one job from the bot and upload it to the user's VRChat account.
export async function processJob(job: Job, server: ServerClient, vrchat: VRChatClient): Promise<JobResult> {
  const pool = poolFor(job.kind);
  try {
    if (job.params.replaceId) {
      // The user picked this exact item to delete in Telegram.
      await deleteFromPool(vrchat, pool, job.params.replaceId);
    } else {
      const full = await fullInventory(job, pool, server, vrchat, false);
      if (full) return full;
    }
    const file = await server.file(job.id);
    const fields = uploadFields(job);
    const vrchatId =
      job.kind === "print"
        ? await vrchat.uploadPrint(file, job.fileName, fields)
        : await vrchat.uploadImage(file, job.fileName, fields);
    return { ok: true, vrchatId };
  } catch (err) {
    if (err instanceof VRChatAuthError) {
      return { ok: false, reason: "session", error: "VRChat login expired" };
    }
    if (err instanceof VRChatApiError) {
      if (!job.params.replaceId && err.status >= 400 && err.status < 500 && LIMIT_ERROR.test(err.message)) {
        const full = await fullInventory(job, pool, server, vrchat, true).catch(() => null);
        if (full) return full;
      }
      return { ok: false, reason: "other", error: `VRChat said: ${err.message} (HTTP ${err.status})` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "other", error: message.slice(0, 300) };
  }
}

import type { Job, JobResult } from "../shared/protocol.ts";
import type { ServerClient } from "./server.ts";
import { VRChatApiError, VRChatAuthError, type VRChatClient } from "./vrchat.ts";

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

// Download one job from the bot and upload it to the user's VRChat account.
export async function processJob(job: Job, server: ServerClient, vrchat: VRChatClient): Promise<JobResult> {
  try {
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
      return { ok: false, reason: "other", error: `VRChat said: ${err.message} (HTTP ${err.status})` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "other", error: message.slice(0, 300) };
  }
}

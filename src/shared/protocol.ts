import { z } from "zod";

// Wire format between the bot server and the companion app.

export const UPLOAD_KINDS = ["sticker", "emoji", "emojianimated", "print"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

// Emoji effects accepted by VRChat's upload endpoint (ImageAnimationStyle).
export const ANIMATION_STYLES = [
  "aura",
  "bats",
  "bees",
  "bounce",
  "cloud",
  "confetti",
  "crying",
  "dislike",
  "fire",
  "idea",
  "lasers",
  "like",
  "magnet",
  "mistletoe",
  "money",
  "noise",
  "orbit",
  "pizza",
  "rain",
  "rotate",
  "shake",
  "snow",
  "snowball",
  "spin",
  "splash",
  "stop",
  "zzz",
] as const;
export type AnimationStyle = (typeof ANIMATION_STYLES)[number];

export const JobParams = z.object({
  animationStyle: z.enum(ANIMATION_STYLES).optional(),
  frames: z.number().int().min(2).max(64).optional(),
  fps: z.number().int().min(1).max(64).optional(),
  note: z.string().optional(),
  takenAt: z.string().optional(),
  // The source image had a transparent background that was kept.
  transparent: z.boolean().optional(),
  // The user confirmed deleting this VRChat file or print to make room before uploading.
  replaceId: z.string().max(200).optional(),
});
export type JobParams = z.infer<typeof JobParams>;

export const Job = z.object({
  id: z.string(),
  kind: z.enum(UPLOAD_KINDS),
  params: JobParams,
  fileName: z.string(),
});
export type Job = z.infer<typeof Job>;

export const NextJobResponse = z.object({ job: Job });

export const PairRequest = z.object({
  code: z.string().min(1).max(64),
  deviceName: z.string().min(1).max(100),
});
export type PairRequest = z.infer<typeof PairRequest>;

export const PairResponse = z.object({
  token: z.string(),
  userName: z.string(),
  // Contact info for the VRChat User-Agent header, set by the bot owner.
  contact: z.string(),
});
export type PairResponse = z.infer<typeof PairResponse>;

export const MeResponse = z.object({
  userName: z.string(),
  deviceName: z.string(),
  queued: z.number().int(),
});

// VRChat inventories that have a slot limit. Emoji and animated emoji share one.
export const INVENTORY_POOLS = ["sticker", "emoji", "print"] as const;
export type InventoryPool = (typeof INVENTORY_POOLS)[number];

export const InventoryFull = z.object({
  pool: z.enum(INVENTORY_POOLS),
  count: z.number().int().min(0),
  limit: z.number().int().min(1),
  oldestId: z.string().min(1).max(200),
  oldestCreatedAt: z.string().max(100),
  // Prints can be saved from other people; false means the oldest one isn't the user's own.
  oldestMine: z.boolean(),
});
export type InventoryFull = z.infer<typeof InventoryFull>;

export const JobResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), vrchatId: z.string().max(200) }),
  z.object({
    ok: z.literal(false),
    error: z.string().max(500),
    // "session": the companion's VRChat login expired; the job goes back in the queue.
    // "full": no free slot; the user is asked whether to delete the oldest item.
    reason: z.enum(["session", "other", "full"]),
    full: InventoryFull.optional(),
  }),
]);
export type JobResult = z.infer<typeof JobResult>;

export const PAIR_PATH = "/pair/";

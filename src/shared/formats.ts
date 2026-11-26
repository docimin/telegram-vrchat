// VRChat image requirements (VRChat Wiki: Inventory, Emojis, Prints pages).

import type { InventoryPool, UploadKind } from "./protocol.ts";

// Slots per inventory for VRC+ accounts. Animated emoji count toward the emoji slots.
export const INVENTORY_LIMITS: Record<InventoryPool, number> = { sticker: 18, emoji: 18, print: 64 };

export function poolFor(kind: UploadKind): InventoryPool {
  if (kind === "print") return "print";
  return kind === "sticker" ? "sticker" : "emoji";
}

export const POOL_NAMES: Record<InventoryPool, { one: string; many: string }> = {
  sticker: { one: "sticker", many: "stickers" },
  emoji: { one: "emoji", many: "emoji" },
  print: { one: "print", many: "prints" },
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MIN_SIDE = 64;

export const STICKER_SIZE = 1024;

export const PRINT_WIDTH = 1920;
export const PRINT_HEIGHT = 1080;

export const SHEET_SIZE = 1024;
export const MAX_FRAMES = 64;
export const MAX_FPS = 30;

// Animated emoji sheets are 1024x1024 with a 2x2, 4x4 or 8x8 grid depending on frame count.
export function gridFor(frames: number): { cols: number; cell: number } {
  if (frames <= 4) return { cols: 2, cell: 512 };
  if (frames <= 16) return { cols: 4, cell: 256 };
  return { cols: 8, cell: 128 };
}

// Pick an output frame rate so the whole clip fits in 64 frames, capped at the source rate.
export function planAnimation(durationSec: number, sourceFps: number): { fps: number; frames: number } {
  const src = Number.isFinite(sourceFps) && sourceFps > 0 ? sourceFps : 10;
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : MAX_FRAMES / src;
  const fps = Math.max(1, Math.min(Math.round(src), MAX_FPS, Math.floor(MAX_FRAMES / duration)));
  const frames = Math.max(1, Math.min(MAX_FRAMES, Math.ceil(duration * fps)));
  return { fps, frames };
}

// VRChat reads "<name>_<n>frames_<f>fps.png" to prefill the frame count and speed on manual upload.
export function animatedFileName(frames: number, fps: number): string {
  return `emoji_${frames}frames_${fps}fps.png`;
}

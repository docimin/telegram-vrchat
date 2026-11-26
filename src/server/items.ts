import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JobParams, UploadKind } from "../shared/protocol.ts";
import { removeWhiteBackground } from "./background.ts";
import { inputPath, itemParams, outputPath } from "./jobs.ts";
import { type PrintMode, makePrint, makeSpriteSheet, makeSquare } from "./media.ts";
import type { ItemRow, Store } from "./store.ts";

// Chat-platform-neutral conversion step: turn an item's input into the VRChat-ready PNG.
export async function convertItem(
  store: Store,
  item: ItemRow,
  kind: UploadKind,
  printMode: PrintMode = "fill",
): Promise<ItemRow> {
  const input = inputPath(item);
  const output = outputPath(item);
  const params: JobParams = { ...itemParams(item) };

  switch (kind) {
    case "sticker":
    case "emoji":
      params.transparent = (await makeSquare(input, output)).transparent;
      break;
    case "print":
      params.transparent = (await makePrint(input, output, printMode)).transparent;
      if (item.caption) params.note = item.caption;
      params.takenAt = new Date(item.taken_at).toISOString();
      break;
    case "emojianimated": {
      const { frames, fps } = await makeSpriteSheet(input, output, item.dir);
      params.frames = frames;
      params.fps = fps;
      break;
    }
  }

  return store.updateItem(item.id, { kind, params: JSON.stringify(params), status: "ready", error: null });
}

const NO_BACKGROUND_NAME = "input-nobg.png";
const MIN_REMOVED = 0.02;
const MAX_REMOVED = 0.98;

export function backgroundRemoved(item: ItemRow): boolean {
  return item.input_name === NO_BACKGROUND_NAME;
}

// Cut the white background out of the item's input. The original file is kept for undo.
export async function removeBackground(
  store: Store,
  item: ItemRow,
): Promise<{ item: ItemRow; outcome: "removed" | "nothing" | "everything" }> {
  const out = join(item.dir, NO_BACKGROUND_NAME);
  const { removedRatio } = await removeWhiteBackground(inputPath(item), out);
  if (removedRatio < MIN_REMOVED || removedRatio > MAX_REMOVED) {
    await rm(out, { force: true });
    return { item, outcome: removedRatio < MIN_REMOVED ? "nothing" : "everything" };
  }
  return { item: store.updateItem(item.id, { input_name: NO_BACKGROUND_NAME }), outcome: "removed" };
}

export async function restoreBackground(store: Store, item: ItemRow): Promise<ItemRow> {
  const original = (await readdir(item.dir)).find((name) => name.startsWith("input."));
  if (!original) return item;
  await rm(join(item.dir, NO_BACKGROUND_NAME), { force: true });
  return store.updateItem(item.id, { input_name: original });
}

export function needsAnimationStyle(item: ItemRow): boolean {
  return (item.kind === "emoji" || item.kind === "emojianimated") && !itemParams(item).animationStyle;
}

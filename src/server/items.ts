import type { JobParams, UploadKind } from "../shared/protocol.ts";
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
      await makeSquare(input, output);
      break;
    case "print":
      await makePrint(input, output, printMode);
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

export function needsAnimationStyle(item: ItemRow): boolean {
  return (item.kind === "emoji" || item.kind === "emojianimated") && !itemParams(item).animationStyle;
}

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { gridFor, planAnimation } from "../src/shared/formats.ts";
import {
  MediaError,
  aspectRatio,
  inspect,
  isPrintShaped,
  makePrint,
  makeSpriteSheet,
  makeSquare,
} from "../src/server/media.ts";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vrc-media-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function transparentLogo(path: string): Promise<void> {
  // 600x400 transparent canvas with a 200x100 red box off-centre.
  const box = await sharp({
    create: { width: 200, height: 100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  await sharp({
    create: { width: 600, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: box, left: 50, top: 50 }])
    .png()
    .toFile(path);
}

async function portraitPhoto(path: string): Promise<void> {
  await sharp({
    create: { width: 900, height: 1600, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .jpeg()
    .toFile(path);
}

describe("formats", () => {
  test("grid follows VRChat's 2x2 / 4x4 / 8x8 layouts", () => {
    expect(gridFor(2)).toEqual({ cols: 2, cell: 512 });
    expect(gridFor(4)).toEqual({ cols: 2, cell: 512 });
    expect(gridFor(5)).toEqual({ cols: 4, cell: 256 });
    expect(gridFor(16)).toEqual({ cols: 4, cell: 256 });
    expect(gridFor(17)).toEqual({ cols: 8, cell: 128 });
    expect(gridFor(64)).toEqual({ cols: 8, cell: 128 });
  });

  test("animation plan keeps clips within 64 frames", () => {
    expect(planAnimation(2, 30)).toEqual({ fps: 30, frames: 60 });
    expect(planAnimation(5, 30)).toEqual({ fps: 12, frames: 60 });
    expect(planAnimation(0.5, 25)).toEqual({ fps: 25, frames: 13 });
    expect(planAnimation(120, 30)).toEqual({ fps: 1, frames: 64 });
    expect(planAnimation(Number.NaN, Number.NaN).frames).toBeLessThanOrEqual(64);
  });
});

describe("still images", () => {
  test("sticker trims transparency and fits into 1024x1024 with alpha", async () => {
    const input = join(dir, "logo.png");
    const out = join(dir, "sticker.png");
    await transparentLogo(input);
    expect(await inspect(input, "png")).toBe("still");
    await makeSquare(input, out);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(1024);
    expect(meta.hasAlpha).toBe(true);
    // The 2:1 box is trimmed and scaled to full width, so the row through the middle is red edge to edge.
    const { data } = await sharp(out).extract({ left: 0, top: 512, width: 1024, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBe(255);
    expect(data[3]).toBe(255);
    // Top-left corner is transparent padding.
    const corner = await sharp(out).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(corner[3]).toBe(0);
  });

  test("print fill crops to 1920x1080", async () => {
    const input = join(dir, "portrait.jpg");
    const out = join(dir, "print-fill.png");
    await portraitPhoto(input);
    expect(isPrintShaped(await aspectRatio(input))).toBe(false);
    await makePrint(input, out, "fill");
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 1920, 1080]);
  });

  test("print fit keeps the whole photo on a blurred 1920x1080 background", async () => {
    const input = join(dir, "portrait.jpg");
    const out = join(dir, "print-fit.png");
    await makePrint(input, out, "fit");
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([1920, 1080, false]);
  });

  test("rejects tiny images", async () => {
    const input = join(dir, "tiny.png");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "#fff" } }).png().toFile(input);
    await expect(inspect(input, "png")).rejects.toBeInstanceOf(MediaError);
  });
});

describe("animations", () => {
  test("video becomes a 1024x1024 sprite sheet", async () => {
    const input = join(dir, "clip.mp4");
    await Bun.spawn(
      ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=20", "-pix_fmt", "yuv420p", input],
      { stdout: "ignore", stderr: "inherit" },
    ).exited;
    expect(await inspect(input, "mp4")).toBe("animated");
    const out = join(dir, "sheet.png");
    const result = await makeSpriteSheet(input, out, dir);
    expect(result.fps).toBe(20);
    expect(result.frames).toBe(20);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([1024, 1024, true]);
    // 20 frames use the 8x8 grid: cell 21 (row 2, col 5) is opaque, cell 20 onward is empty.
    const used = await sharp(out).extract({ left: 5 * 128 + 64, top: 2 * 128 + 64, width: 1, height: 1 }).raw().toBuffer();
    const unused = await sharp(out).extract({ left: 4 * 128 + 64, top: 2 * 128 + 64, width: 1, height: 1 }).raw().toBuffer();
    expect(used[3]).toBe(0);
    expect(unused[3]).toBe(0);
    const first = await sharp(out).extract({ left: 64, top: 64, width: 1, height: 1 }).raw().toBuffer();
    expect(first[3]).toBe(255);
  });

  test("animated GIF keeps transparency", async () => {
    const input = join(dir, "anim.gif");
    await Bun.spawn(
      [
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
        "color=c=red@0.0:s=128x128:d=0.5:r=10,format=rgba,drawbox=x=32:y=32:w=64:h=64:color=blue@1:t=fill,split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128",
        input,
      ],
      { stdout: "ignore", stderr: "inherit" },
    ).exited;
    expect(await inspect(input, "gif")).toBe("animated");
    const out = join(dir, "gif-sheet.png");
    const result = await makeSpriteSheet(input, out, dir);
    expect(result.frames).toBe(5);
    const corner = await sharp(out).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(corner[3]).toBe(0);
  });
});

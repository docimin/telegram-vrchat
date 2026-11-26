import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { gridFor, planAnimation } from "../src/shared/formats.ts";
import {
  MediaError,
  aspectRatio,
  hasTransparency,
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

  // 400x300 RGBA: invisible pixels carry bright red colour data, a 100x100 opaque blue box sits in the middle.
  async function transparentArt(path: string): Promise<void> {
    const w = 400;
    const h = 300;
    const raw = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inBox = x >= 150 && x < 250 && y >= 100 && y < 200;
        raw.set(inBox ? [0, 0, 255, 255] : [255, 0, 0, 0], i);
      }
    }
    await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path);
  }

  async function pixel(path: string, x: number, y: number): Promise<number[]> {
    return [...(await sharp(path).ensureAlpha().extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
  }

  test("transparent picture as print keeps its transparency in both modes", async () => {
    const input = join(dir, "art.png");
    await transparentArt(input);
    expect(await hasTransparency(input)).toBe(true);
    for (const mode of ["fit", "fill"] as const) {
      const out = join(dir, `art-print-${mode}.png`);
      expect(await makePrint(input, out, mode)).toEqual({ transparent: true });
      const meta = await sharp(out).metadata();
      expect([meta.width, meta.height, meta.hasAlpha]).toEqual([1920, 1080, true]);
      // Hidden red never becomes visible; the box stays opaque blue.
      expect((await pixel(out, 0, 0))[3]).toBe(0);
      expect(await pixel(out, 960, 540)).toEqual([0, 0, 255, 255]);
      const { channels } = await sharp(out).stats();
      const visibleRed = await sharp(out).ensureAlpha().raw().toBuffer();
      let leaked = 0;
      for (let i = 0; i < visibleRed.length; i += 4) {
        if ((visibleRed[i + 3] ?? 0) > 0 && (visibleRed[i] ?? 0) > 128) leaked++;
      }
      expect(leaked).toBe(0);
      expect(channels).toHaveLength(4);
    }
  });

  test("an alpha channel that is fully opaque counts as no transparency", async () => {
    const input = join(dir, "opaque-rgba.png");
    await sharp({ create: { width: 320, height: 180, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } })
      .png()
      .toFile(input);
    expect(await hasTransparency(input)).toBe(false);
    const out = join(dir, "opaque-print.png");
    expect(await makePrint(input, out, "fill")).toEqual({ transparent: false });
    expect((await sharp(out).metadata()).hasAlpha).toBe(false);
    expect(await makeSquare(join(dir, "portrait.jpg"), join(dir, "jpeg-sticker.png"))).toEqual({ transparent: false });
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
        "color=c=red@0.0:s=128x128:d=0.5:r=10,format=rgba,drawbox=x=32:y=32:w=64:h=64:color=blue@1:t=fill:replace=1,split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128",
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

  test("transparent VP9 WebM keeps its alpha", async () => {
    const input = join(dir, "alpha.webm");
    const code = await Bun.spawn(
      [
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
        "color=c=red@0.0:s=128x128:d=0.5:r=10,format=rgba,drawbox=x=32:y=32:w=64:h=64:color=blue@1:t=fill:replace=1",
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", input,
      ],
      { stdout: "ignore", stderr: "inherit" },
    ).exited;
    expect(code).toBe(0);
    const out = join(dir, "webm-sheet.png");
    const result = await makeSpriteSheet(input, out, dir);
    expect(result.frames).toBe(5);
    // 5 frames use the 4x4 grid: the first 256x256 cell has a transparent corner and the opaque box in the middle.
    const corner = await sharp(out).extract({ left: 5, top: 5, width: 1, height: 1 }).raw().toBuffer();
    const middle = await sharp(out).extract({ left: 128, top: 128, width: 1, height: 1 }).raw().toBuffer();
    expect(corner[3]).toBe(0);
    expect(middle[3]).toBe(255);
  });
});

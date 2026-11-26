import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { removeWhiteBackground, whiteBorderRatio } from "../src/server/background.ts";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vrc-bg-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// White JPEG with a black-outlined circle that is white inside, plus a soft grey blob touching nothing.
async function sticker(path: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <rect width="400" height="400" fill="#ffffff"/>
    <circle cx="200" cy="200" r="120" fill="#ffffff" stroke="#111111" stroke-width="12"/>
    <circle cx="200" cy="200" r="40" fill="#3366cc"/>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toFile(path);
}

async function pixel(path: string, x: number, y: number): Promise<number[]> {
  return [...(await sharp(path).ensureAlpha().extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
}

describe("white background removal", () => {
  test("detects a white border", async () => {
    const white = join(dir, "white.jpg");
    await sticker(white);
    expect(await whiteBorderRatio(white)).toBeGreaterThan(0.99);

    const dark = join(dir, "dark.jpg");
    await sharp({ create: { width: 200, height: 200, channels: 3, background: "#203040" } }).jpeg().toFile(dark);
    expect(await whiteBorderRatio(dark)).toBe(0);
  });

  test("removes white connected to the edges and keeps white enclosed by an outline", async () => {
    const input = join(dir, "sticker.jpg");
    const out = join(dir, "sticker-nobg.png");
    await sticker(input);
    const { removedRatio } = await removeWhiteBackground(input, out);
    // Area outside the circle (radius 126 incl. stroke): 1 - pi*126^2/400^2, about 0.69.
    expect(removedRatio).toBeGreaterThan(0.6);
    expect(removedRatio).toBeLessThan(0.75);
    expect((await pixel(out, 5, 5))[3]).toBe(0);
    expect((await pixel(out, 200, 40))[3]).toBe(0);
    // Outline, white inside the outline, and the blue centre stay opaque.
    expect((await pixel(out, 200, 80))[3]).toBe(255);
    const inside = await pixel(out, 200, 120);
    expect(inside[3]).toBe(255);
    expect(inside[0]).toBeGreaterThan(240);
    const [r = 0, g = 0, b = 0, a = 0] = await pixel(out, 200, 200);
    expect(Math.abs(r - 51)).toBeLessThan(12);
    expect(Math.abs(g - 102)).toBeLessThan(12);
    expect(Math.abs(b - 204)).toBeLessThan(12);
    expect(a).toBe(255);
  });

  test("softens the cut edge instead of leaving a white fringe", async () => {
    const input = join(dir, "sticker.jpg");
    const out = join(dir, "sticker-nobg.png");
    await removeWhiteBackground(input, out);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    let partial = 0;
    let whiteFringe = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const a = data[i + 3] ?? 0;
      if (a > 0 && a < 255) {
        partial++;
        // A half-transparent pixel that is still near white would show as a light halo on dark backgrounds.
        if (Math.min(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0) > 200) whiteFringe++;
      }
    }
    expect(partial).toBeGreaterThan(0);
    expect(whiteFringe / partial).toBeLessThan(0.05);
  });

  test("an all-white image would lose everything", async () => {
    const input = join(dir, "blank.jpg");
    await sharp({ create: { width: 100, height: 100, channels: 3, background: "#ffffff" } }).jpeg().toFile(input);
    const { removedRatio } = await removeWhiteBackground(input, join(dir, "blank-nobg.png"));
    expect(removedRatio).toBe(1);
  });
});

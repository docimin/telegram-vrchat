import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type Metadata, type Sharp } from "sharp";
import { z } from "zod";
import {
  MAX_UPLOAD_BYTES,
  MIN_SIDE,
  PRINT_HEIGHT,
  PRINT_WIDTH,
  SHEET_SIZE,
  STICKER_SIZE,
  gridFor,
  planAnimation,
} from "../shared/formats.ts";

export type SourceType = "still" | "animated";
export type PrintMode = "fill" | "fit";

export class MediaError extends Error {}

const FRAME_SIZE = 512;
const PRINT_ASPECT = PRINT_WIDTH / PRINT_HEIGHT;

const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "gif"]);

// Decide whether a downloaded file is a still image or an animation.
export async function inspect(path: string, ext: string): Promise<SourceType> {
  if (VIDEO_EXTENSIONS.has(ext) && ext !== "gif") return "animated";
  let meta: Metadata;
  try {
    meta = await sharp(path).metadata();
  } catch {
    throw new MediaError("That file doesn't look like an image I can read.");
  }
  if (meta.width < MIN_SIDE || meta.height < MIN_SIDE) {
    throw new MediaError(`The image is too small, VRChat needs at least ${MIN_SIDE}x${MIN_SIDE}.`);
  }
  const pages = meta.pages ?? 1;
  if (pages > 1) {
    if (ext === "gif") return "animated";
    throw new MediaError("Animated WebP isn't supported yet, send it as a GIF or MP4 instead.");
  }
  return "still";
}

export async function aspectRatio(path: string): Promise<number> {
  const meta = await sharp(path).metadata();
  return meta.autoOrient.width / Math.max(1, meta.autoOrient.height);
}

export function isPrintShaped(ratio: number): boolean {
  return Math.abs(ratio - PRINT_ASPECT) / PRINT_ASPECT < 0.03;
}

async function writePng(pipeline: Sharp, out: string): Promise<void> {
  const info = await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(out);
  if (info.size > MAX_UPLOAD_BYTES) {
    await rm(out, { force: true });
    throw new MediaError("The converted image is over VRChat's 10MB limit.");
  }
}

const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

// True when the image has an alpha channel that is actually used (not just fully opaque).
export async function hasTransparency(input: string): Promise<boolean> {
  const { hasAlpha } = await sharp(input).metadata();
  if (!hasAlpha) return false;
  const { isOpaque } = await sharp(input).stats();
  return !isOpaque;
}

export interface StillResult {
  transparent: boolean;
}

// Stickers and static emoji: trim transparent edges, then fit into a transparent 1024x1024 square.
export async function makeSquare(input: string, out: string): Promise<StillResult> {
  const transparent = await hasTransparency(input);
  const base = await sharp(input).autoOrient().ensureAlpha().toBuffer();
  let trimmed = base;
  if (transparent) {
    try {
      trimmed = await sharp(base).trim({ background: CLEAR, threshold: 1 }).toBuffer();
    } catch {
      // Nothing to trim: keep the original.
    }
  }
  await writePng(
    sharp(trimmed).resize(STICKER_SIZE, STICKER_SIZE, {
      fit: "contain",
      background: CLEAR,
      kernel: "lanczos3",
    }),
    out,
  );
  return { transparent };
}

// Prints are 1920x1080. "fill" crops to 16:9. "fit" keeps the whole picture: transparent images
// are padded with transparency, opaque photos sit on a blurred copy of themselves.
export async function makePrint(input: string, out: string, mode: PrintMode): Promise<StillResult> {
  const transparent = await hasTransparency(input);
  // Only drop the alpha channel when it carries nothing; on transparent images it would expose
  // the hidden colour data of invisible pixels.
  const oriented = sharp(input).autoOrient();
  const source = await (transparent ? oriented : oriented.removeAlpha()).toBuffer();
  if (mode === "fill") {
    await writePng(
      sharp(source).resize(PRINT_WIDTH, PRINT_HEIGHT, { fit: "cover", position: "attention" }),
      out,
    );
    return { transparent };
  }
  if (transparent) {
    await writePng(
      sharp(source).resize(PRINT_WIDTH, PRINT_HEIGHT, { fit: "contain", background: CLEAR }),
      out,
    );
    return { transparent };
  }
  const background = await sharp(source)
    .resize(PRINT_WIDTH, PRINT_HEIGHT, { fit: "cover" })
    .blur(40)
    .modulate({ brightness: 0.7 })
    .toBuffer();
  const foreground = await sharp(source)
    .resize(PRINT_WIDTH, PRINT_HEIGHT, { fit: "inside" })
    .toBuffer();
  const composed = await sharp(background)
    .composite([{ input: foreground, gravity: "center" }])
    .toBuffer();
  await writePng(sharp(composed).removeAlpha(), out);
  return { transparent };
}

const ProbeOutput = z.object({
  streams: z
    .array(
      z.object({
        codec_name: z.string().optional(),
        avg_frame_rate: z.string().optional(),
        r_frame_rate: z.string().optional(),
        duration: z.string().optional(),
      }),
    )
    .default([]),
  format: z.object({ duration: z.string().optional() }).optional(),
});

function parseRate(rate: string | undefined): number {
  if (!rate) return Number.NaN;
  const [num, den] = rate.split("/").map(Number);
  if (num === undefined || !Number.isFinite(num)) return Number.NaN;
  if (den === undefined) return num;
  return den > 0 ? num / den : Number.NaN;
}

async function run(cmd: string[]): Promise<string> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error(`${cmd[0]} is not installed or not on PATH`);
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} failed (${code}): ${stderr.trim().slice(-500)}`);
  return stdout;
}

export async function probe(input: string): Promise<{ duration: number; fps: number; codec: string }> {
  const raw = await run([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,avg_frame_rate,r_frame_rate,duration:format=duration",
    "-of",
    "json",
    input,
  ]);
  const parsed = ProbeOutput.parse(JSON.parse(raw));
  const stream = parsed.streams[0];
  let fps = parseRate(stream?.avg_frame_rate);
  if (!Number.isFinite(fps) || fps <= 0) fps = parseRate(stream?.r_frame_rate);
  let duration = Number(stream?.duration);
  if (!Number.isFinite(duration) || duration <= 0) duration = Number(parsed.format?.duration);
  return { duration, fps, codec: stream?.codec_name ?? "" };
}

// FFmpeg's built-in VP8/VP9 decoders ignore the alpha layer of transparent WebM; libvpx reads it.
const ALPHA_DECODERS: Record<string, string> = { vp8: "libvpx", vp9: "libvpx-vp9" };

// GIF or video to a 1024x1024 animated emoji sprite sheet.
export async function makeSpriteSheet(
  input: string,
  out: string,
  workDir: string,
): Promise<{ frames: number; fps: number }> {
  const { duration, fps: sourceFps, codec } = await probe(input);
  const plan = planAnimation(duration, sourceFps);
  const decoder = ALPHA_DECODERS[codec];
  const framesDir = join(workDir, "frames");
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });
  try {
    const filter = [
      `fps=${plan.fps}`,
      `scale=${FRAME_SIZE}:${FRAME_SIZE}:force_original_aspect_ratio=decrease:flags=lanczos`,
      "format=rgba",
      `pad=${FRAME_SIZE}:${FRAME_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
    ].join(",");
    await run([
      "ffmpeg",
      "-v",
      "error",
      ...(decoder ? ["-c:v", decoder] : []),
      "-i",
      input,
      "-vf",
      filter,
      "-frames:v",
      String(plan.frames),
      join(framesDir, "f_%03d.png"),
    ]);
    const files = (await readdir(framesDir)).filter((f) => f.endsWith(".png")).sort();
    if (files.length < 2) {
      throw new MediaError("That animation is too short, it needs at least 2 frames.");
    }
    const { cols, cell } = gridFor(files.length);
    const tiles = await Promise.all(
      files.map(async (file, i) => ({
        input: await sharp(join(framesDir, file)).resize(cell, cell).png().toBuffer(),
        left: (i % cols) * cell,
        top: Math.floor(i / cols) * cell,
      })),
    );
    const sheet = sharp({
      create: {
        width: SHEET_SIZE,
        height: SHEET_SIZE,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).composite(tiles);
    await writePng(sheet, out);
    return { frames: files.length, fps: plan.fps };
  } finally {
    await rm(framesDir, { recursive: true, force: true });
  }
}

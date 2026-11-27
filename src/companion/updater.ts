import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { RELEASE_ASSETS, RELEASE_REPO, platformOf } from "../shared/release.ts";

// Self-update from GitHub releases. Only the standalone executable updates itself; running from
// source with `bun run` never replaces anything.

const GITHUB_API = "https://api.github.com";
const SUMS_NAME = "SHA256SUMS";
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;

const Release = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string(), size: z.number() })),
});

export interface UpdateInfo {
  version: string;
  pageUrl: string;
  assetName: string;
  assetUrl: string;
  sumsUrl: string;
}

export class UpdateError extends Error {}

function parseVersion(version: string): number[] {
  const core = version.replace(/^v/i, "").split(/[-+]/)[0] ?? "";
  return core.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

// Negative when a < b, positive when a > b.
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Release file for this computer, as published by the build workflow.
export function assetNameFor(nodePlatform: NodeJS.Platform = process.platform): string | null {
  const platform = platformOf(nodePlatform);
  return platform ? RELEASE_ASSETS[platform] : null;
}

// True for the compiled companion; false when running under the bun binary from source.
export function isStandalone(execPath: string = process.execPath): boolean {
  const name = execPath.split(/[\\/]/).pop() ?? "";
  return !/^bun(\.exe)?$/i.test(name);
}

export async function checkForUpdate(
  current: string,
  options: { userAgent: string; api?: string; repo?: string },
): Promise<UpdateInfo | null> {
  const api = (options.api ?? process.env.VRC_COMPANION_UPDATE_API ?? GITHUB_API).replace(/\/+$/, "");
  const repo = options.repo ?? RELEASE_REPO;
  const res = await fetch(`${api}/repos/${repo}/releases/latest`, {
    headers: { "User-Agent": options.userAgent, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new UpdateError(`GitHub answered HTTP ${res.status}`);
  const release = Release.parse(await res.json());
  if (compareVersions(release.tag_name, current) <= 0) return null;
  const name = assetNameFor();
  const asset = release.assets.find((a) => a.name === name);
  const sums = release.assets.find((a) => a.name === SUMS_NAME);
  if (!name || !asset || !sums) return null;
  return {
    version: release.tag_name.replace(/^v/i, ""),
    pageUrl: release.html_url,
    assetName: name,
    assetUrl: asset.browser_download_url,
    sumsUrl: sums.browser_download_url,
  };
}

async function download(url: string, userAgent: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new UpdateError(`Download failed with HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) throw new UpdateError("Download is unexpectedly large");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new UpdateError("Download is unexpectedly large");
  return bytes;
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

// "<hex>  <name>" lines, as written by sha256sum.
export function expectedChecksum(sums: string, name: string): string | null {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match?.[2] === name && match[1]) return match[1].toLowerCase();
  }
  return null;
}

// Pull one regular file out of a .tar.gz (ustar/GNU headers, as GNU tar writes them).
export function extractFromTarGz(gz: Uint8Array<ArrayBuffer>, fileName: string): Uint8Array<ArrayBuffer> {
  const tar = Bun.gunzipSync(gz);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/s, "");
    const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + 512;
    if ((type === "0" || type === "\0") && basename(name) === fileName) {
      if (start + size > tar.length) throw new UpdateError("The downloaded archive is truncated");
      return tar.slice(start, start + size);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  throw new UpdateError(`${fileName} not found in the downloaded archive`);
}

export function oldExecutablePath(path: string): string {
  return `${path}.old`;
}

// Swap the executable at `path` for `bytes`. On Unix the running file can be replaced directly;
// Windows only allows renaming a running .exe, so the old one is moved aside and deleted next start.
export async function replaceExecutable(path: string, bytes: Uint8Array, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    const old = oldExecutablePath(path);
    await rm(old, { force: true });
    await rename(path, old);
    try {
      await writeFile(path, bytes);
    } catch (err) {
      await rename(old, path).catch(() => undefined);
      throw err;
    }
    return;
  }
  const temp = `${path}.new`;
  try {
    await writeFile(temp, bytes, { mode: 0o755 });
    await chmod(temp, 0o755);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}

export async function installUpdate(update: UpdateInfo, targetPath: string, userAgent: string): Promise<void> {
  const [asset, sums] = await Promise.all([
    download(update.assetUrl, userAgent),
    download(update.sumsUrl, userAgent).then((b) => new TextDecoder().decode(b)),
  ]);
  const expected = expectedChecksum(sums, update.assetName);
  if (!expected) throw new UpdateError(`${update.assetName} is missing from ${SUMS_NAME}`);
  if (sha256(asset) !== expected) throw new UpdateError("Checksum mismatch, the download is damaged");
  const binary = update.assetName.endsWith(".tar.gz")
    ? extractFromTarGz(asset, update.assetName.replace(/\.tar\.gz$/, ""))
    : asset;
  if (binary.length < 1024) throw new UpdateError("The downloaded program is unexpectedly small");
  await replaceExecutable(targetPath, binary);
}

// Remove what a Windows update left behind; harmless everywhere else.
export async function cleanupAfterUpdate(path: string = process.execPath): Promise<void> {
  await rm(oldExecutablePath(path), { force: true }).catch(() => undefined);
}

// Start the freshly installed program with the same arguments and hand over the terminal.
export async function restart(): Promise<never> {
  const child = Bun.spawn([process.execPath, ...process.argv.slice(2)], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, VRC_COMPANION_UPDATED: "1" },
  });
  process.exit(await child.exited);
}

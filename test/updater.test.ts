import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UpdateError,
  assetNameFor,
  checkForUpdate,
  cleanupAfterUpdate,
  compareVersions,
  expectedChecksum,
  extractFromTarGz,
  installUpdate,
  isStandalone,
  oldExecutablePath,
  replaceExecutable,
  sha256,
} from "../src/companion/updater.ts";

let dir = "";
let github: ReturnType<typeof Bun.serve>;
const files = new Map<string, Uint8Array<ArrayBuffer>>();
const release = { tag: "v9.9.9", corruptSums: false, withSums: true };

const NEW_BINARY = new TextEncoder().encode(`#!/bin/sh\necho new\n${"#".repeat(4096)}\n`);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vrc-update-"));
  // Release assets as the workflow builds them: a tarball holding the binary, plus checksums.
  const stage = join(dir, "stage");
  await mkdir(stage);
  await writeFile(join(stage, "vrc-companion-linux"), NEW_BINARY, { mode: 0o755 });
  const tarball = join(dir, "vrc-companion-linux.tar.gz");
  expect(await Bun.spawn(["tar", "-czf", tarball, "-C", stage, "vrc-companion-linux"]).exited).toBe(0);
  files.set("vrc-companion-linux.tar.gz", new Uint8Array(await readFile(tarball)));
  files.set("vrc-companion-windows.exe", new Uint8Array(NEW_BINARY));

  github = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/repos/docimin/telegram-vrchat/releases/latest": (req) => {
        const base = new URL(req.url).origin;
        const names = [...files.keys(), ...(release.withSums ? ["SHA256SUMS"] : [])];
        return Response.json({
          tag_name: release.tag,
          html_url: `${base}/releases/${release.tag}`,
          assets: names.map((name) => ({ name, size: 1, browser_download_url: `${base}/download/${name}` })),
        });
      },
      // GitHub redirects asset downloads to its storage host.
      "/download/:name": (req) => new Response(null, { status: 302, headers: { location: `/storage/${req.params.name}` } }),
      "/storage/:name": (req) => {
        if (req.params.name === "SHA256SUMS") {
          const lines = [...files].map(([name, bytes]) => `${release.corruptSums ? "0".repeat(64) : sha256(bytes)}  ${name}`);
          return new Response(`${lines.join("\n")}\n`);
        }
        const bytes = files.get(req.params.name);
        return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });
});

afterAll(async () => {
  await github.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const ua = "vrc-companion-test";

describe("versions and platforms", () => {
  test("compares versions numerically", () => {
    expect(compareVersions("v0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("v2.0.0-beta.1", "1.9.0")).toBeGreaterThan(0);
  });

  test("picks the release file per system and only updates compiled binaries", () => {
    expect(assetNameFor("win32")).toBe("vrc-companion-windows.exe");
    expect(assetNameFor("linux")).toBe("vrc-companion-linux.tar.gz");
    expect(assetNameFor("darwin")).toBe("vrc-companion-macos.tar.gz");
    expect(assetNameFor("aix")).toBeNull();
    expect(isStandalone("/home/me/.bun/bin/bun")).toBe(false);
    expect(isStandalone("C:\\tools\\bun.exe")).toBe(false);
    expect(isStandalone("/home/me/Downloads/vrc-companion-linux")).toBe(true);
    expect(isStandalone("C:\\Users\\me\\vrc-companion-windows.exe")).toBe(true);
  });

  test("reads sha256sum output", () => {
    const sums = `${"a".repeat(64)}  vrc-companion-linux.tar.gz\n${"b".repeat(64)} *vrc-companion-windows.exe\n`;
    expect(expectedChecksum(sums, "vrc-companion-linux.tar.gz")).toBe("a".repeat(64));
    expect(expectedChecksum(sums, "vrc-companion-windows.exe")).toBe("b".repeat(64));
    expect(expectedChecksum(sums, "other")).toBeNull();
  });

  test("extracts the binary from a release tarball", () => {
    const tarball = files.get("vrc-companion-linux.tar.gz");
    if (!tarball) throw new Error("fixture missing");
    expect(extractFromTarGz(tarball, "vrc-companion-linux")).toEqual(NEW_BINARY);
    expect(() => extractFromTarGz(tarball, "nope")).toThrow(UpdateError);
  });
});

describe("check and install", () => {
  const api = () => github.url.origin;

  test("finds a newer release, ignores the same or older one", async () => {
    release.tag = "v9.9.9";
    const update = await checkForUpdate("0.1.0", { userAgent: ua, api: api() });
    expect(update?.version).toBe("9.9.9");
    expect(update?.assetName).toBe(assetNameFor() ?? "unsupported");
    release.tag = "v0.1.0";
    expect(await checkForUpdate("0.1.0", { userAgent: ua, api: api() })).toBeNull();
    release.tag = "v9.9.9";
  });

  test("a release without checksums is not offered", async () => {
    release.withSums = false;
    expect(await checkForUpdate("0.1.0", { userAgent: ua, api: api() })).toBeNull();
    release.withSums = true;
  });

  test("installs over the running file after verifying the checksum", async () => {
    const target = join(dir, "vrc-companion-linux");
    await writeFile(target, "old program", { mode: 0o755 });
    const update = await checkForUpdate("0.1.0", { userAgent: ua, api: api() });
    if (!update) throw new Error("no update");
    await installUpdate(update, target, ua);
    expect(new Uint8Array(await readFile(target))).toEqual(NEW_BINARY);
    if (process.platform !== "win32") expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  test("a checksum mismatch leaves the current program untouched", async () => {
    const target = join(dir, "keep-me");
    await writeFile(target, "old program", { mode: 0o755 });
    release.corruptSums = true;
    const update = await checkForUpdate("0.1.0", { userAgent: ua, api: api() });
    if (!update) throw new Error("no update");
    await expect(installUpdate(update, target, ua)).rejects.toThrow(/Checksum mismatch/);
    release.corruptSums = false;
    expect(await readFile(target, "utf8")).toBe("old program");
  });

  test("Windows: the running exe is moved aside and removed on the next start", async () => {
    const target = join(dir, "vrc-companion-windows.exe");
    await writeFile(target, "old exe");
    await replaceExecutable(target, NEW_BINARY, "win32");
    expect(new Uint8Array(await readFile(target))).toEqual(NEW_BINARY);
    expect(await readFile(oldExecutablePath(target), "utf8")).toBe("old exe");
    await cleanupAfterUpdate(target);
    expect(await Bun.file(oldExecutablePath(target)).exists()).toBe(false);
  });
});

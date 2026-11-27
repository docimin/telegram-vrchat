// Where the companion is published. The build workflow attaches these files to every GitHub release,
// the companion updates itself from them, and the bot links to them.

export const RELEASE_REPO = "docimin/telegram-vrchat";

export const PLATFORMS = ["windows", "linux", "macos"] as const;
export type Platform = (typeof PLATFORMS)[number];

// Raw executables from `bun run build:companion`, served by the bot when they exist in DIST_DIR.
export const LOCAL_BUILDS: Record<Platform, string> = {
  windows: "vrc-companion-windows.exe",
  linux: "vrc-companion-linux",
  macos: "vrc-companion-macos",
};

// Files on a GitHub release. Linux and macOS are tarballs so the executable bit survives the download.
export const RELEASE_ASSETS: Record<Platform, string> = {
  windows: "vrc-companion-windows.exe",
  linux: "vrc-companion-linux.tar.gz",
  macos: "vrc-companion-macos.tar.gz",
};

export function platformOf(nodePlatform: NodeJS.Platform): Platform | null {
  if (nodePlatform === "win32") return "windows";
  if (nodePlatform === "linux") return "linux";
  if (nodePlatform === "darwin") return "macos";
  return null;
}

export function latestReleaseDownload(platform: Platform, repo: string = RELEASE_REPO): string {
  return `https://github.com/${repo}/releases/latest/download/${RELEASE_ASSETS[platform]}`;
}

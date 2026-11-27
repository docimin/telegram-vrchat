// Builds standalone companion executables into dist/. The bot serves them at /download/<platform>
// when present; otherwise it links to the latest GitHub release.
import { LOCAL_BUILDS, type Platform } from "../src/shared/release.ts";

const TARGETS: Array<{ platform: Platform; target: string }> = [
  { platform: "windows", target: "bun-windows-x64" },
  { platform: "linux", target: "bun-linux-x64" },
  { platform: "macos", target: "bun-darwin-arm64" },
];

const only = process.argv.slice(2);

for (const { platform, target } of TARGETS) {
  if (only.length && !only.includes(platform)) continue;
  const outfile = `dist/${LOCAL_BUILDS[platform]}`;
  const proc = Bun.spawn(
    ["bun", "build", "src/companion/main.ts", "--compile", "--minify", `--target=${target}`, `--outfile=${outfile}`],
    { stdout: "inherit", stderr: "inherit" },
  );
  if ((await proc.exited) !== 0) {
    console.error(`Build failed for ${platform}`);
    process.exit(1);
  }
  console.log(`Built ${outfile}`);
}

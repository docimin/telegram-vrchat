import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const CompanionConfig = z.object({
  server: z
    .object({
      url: z.string(),
      token: z.string(),
      contact: z.string(),
      userName: z.string(),
    })
    .optional(),
  vrchat: z
    .object({
      // Session cookies only. The VRChat password is never written to disk.
      cookies: z.record(z.string(), z.string()),
      displayName: z.string().optional(),
    })
    .optional(),
});
export type CompanionConfig = z.infer<typeof CompanionConfig>;

export function configPath(): string {
  const override = process.env.VRC_COMPANION_CONFIG;
  if (override) return override;
  if (process.platform === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "vrc-companion", "config.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "vrc-companion", "config.json");
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "vrc-companion", "config.json");
}

export async function loadConfig(): Promise<CompanionConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath(), "utf8");
  } catch {
    return {};
  }
  const parsed = CompanionConfig.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.warn(`Ignoring unreadable config at ${configPath()}`);
    return {};
  }
  return parsed.data;
}

export async function saveConfig(config: CompanionConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

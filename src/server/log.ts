// Error logging that never prints secrets. Telegram puts the bot token in every request URL,
// and network errors echo that URL, so everything goes through redaction first.

const secrets = new Set<string>();

export function addSecret(secret: string): void {
  if (secret) secrets.add(secret);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("<redacted>");
  return out;
}

export function logError(message: string, err?: unknown): void {
  const detail = err === undefined ? "" : ` ${typeof err === "object" && err !== null ? Bun.inspect(err) : String(err)}`;
  console.error(redact(`${message}${detail}`));
}

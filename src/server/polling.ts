import { GrammyError } from "grammy";

export interface ConflictGraceOptions {
  // How long to keep retrying while another copy of the bot holds the token.
  graceMs: number;
  // Pause between attempts.
  retryMs: () => number;
  isStopping: () => boolean;
  // Called once at the start of each conflict.
  onConflict: () => void;
}

export function isConflict(err: unknown): boolean {
  return err instanceof GrammyError && err.error_code === 409;
}

// Run long polling and start it again while Telegram answers 409 (another copy is polling).
// During a redeploy the old and new copy overlap for a moment; retrying lets the new copy take over
// (each attempt also cuts off the other copy's request) instead of the new one giving up for good.
// Gives up with the 409 error if the conflict lasts longer than graceMs.
export async function pollWithConflictGrace(start: () => Promise<void>, options: ConflictGraceOptions): Promise<void> {
  let conflictSince: number | null = null;
  for (;;) {
    const startedAt = Date.now();
    try {
      await start();
      return;
    } catch (err) {
      if (options.isStopping()) return;
      if (!isConflict(err)) throw err;
      const now = Date.now();
      // Polling ran fine for longer than the grace period before this: treat it as a new conflict.
      if (conflictSince === null || now - startedAt > options.graceMs) {
        conflictSince = now;
        options.onConflict();
      }
      if (now - conflictSince >= options.graceMs) throw err;
      await Bun.sleep(options.retryMs());
    }
  }
}

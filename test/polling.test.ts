import { describe, expect, test } from "bun:test";
import { GrammyError } from "grammy";
import { pollWithConflictGrace } from "../src/server/polling.ts";

function conflict(): GrammyError {
  return new GrammyError(
    "Call to 'getUpdates' failed!",
    { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" },
    "getUpdates",
    {},
  );
}

function options(graceMs: number, stopping = () => false) {
  const events = { conflicts: 0 };
  return {
    events,
    opts: { graceMs, retryMs: () => 5, isStopping: stopping, onConflict: () => events.conflicts++ },
  };
}

describe("polling through a 409 conflict", () => {
  test("keeps retrying while the other copy goes away, then polls normally", async () => {
    let calls = 0;
    const { events, opts } = options(1_000);
    await pollWithConflictGrace(async () => {
      calls++;
      if (calls <= 3) throw conflict();
    }, opts);
    expect(calls).toBe(4);
    expect(events.conflicts).toBe(1);
  });

  test("gives up with the 409 when the conflict outlasts the grace period", async () => {
    let calls = 0;
    const { opts } = options(60);
    const started = Date.now();
    await expect(
      pollWithConflictGrace(async () => {
        calls++;
        throw conflict();
      }, opts),
    ).rejects.toBeInstanceOf(GrammyError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(calls).toBeGreaterThan(1);
  });

  test("other errors are not retried, and stopping ends quietly", async () => {
    const { opts } = options(1_000);
    await expect(
      pollWithConflictGrace(async () => {
        throw new Error("boom");
      }, opts),
    ).rejects.toThrow("boom");

    let stopping = false;
    const quiet = options(1_000, () => stopping);
    await pollWithConflictGrace(async () => {
      stopping = true;
      throw conflict();
    }, quiet.opts);
    expect(quiet.events.conflicts).toBe(0);
  });
});

import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { UploadKind } from "../shared/protocol.ts";
import type { SourceType } from "./media.ts";

// "full": the VRChat inventory for this kind had no free slot; the user is asked to replace the oldest item.
export type ItemStatus = "new" | "ready" | "queued" | "uploading" | "done" | "failed" | "full" | "cancelled";

export interface UserRow {
  id: number;
  telegram_id: number | null;
  name: string;
  allowed: number;
  created_at: number;
}

export interface DeviceRow {
  id: number;
  user_id: number;
  name: string;
  created_at: number;
  last_seen_at: number | null;
}

export interface ItemRow {
  id: string;
  user_id: number;
  chat_id: number;
  source: SourceType;
  dir: string;
  input_name: string;
  caption: string | null;
  taken_at: number;
  kind: UploadKind | null;
  params: string;
  status: ItemStatus;
  message_id: number | null;
  error: string | null;
  vrchat_id: string | null;
  // JSON of InventoryFull when status is "full".
  offer: string | null;
  claimed_at: number | null;
  created_at: number;
  updated_at: number;
}

export type ItemPatch = Partial<
  Pick<
    ItemRow,
    "kind" | "params" | "status" | "message_id" | "error" | "vrchat_id" | "claimed_at" | "input_name" | "offer"
  >
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  telegram_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  allowed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_by INTEGER,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS pair_codes (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  dir TEXT NOT NULL,
  input_name TEXT NOT NULL,
  caption TEXT,
  taken_at INTEGER NOT NULL,
  kind TEXT,
  params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  message_id INTEGER,
  error TEXT,
  vrchat_id TEXT,
  offer TEXT,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_queue ON items (user_id, status, updated_at);
`;

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function randomCode(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

export function randomId(): string {
  return randomCode(12).toLowerCase();
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  // Columns added after the first release, for databases created before them.
  private migrate(): void {
    const columns = new Set(
      this.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('items')").all().map((c) => c.name),
    );
    if (!columns.has("offer")) this.db.exec("ALTER TABLE items ADD COLUMN offer TEXT");
  }

  close(): void {
    this.db.close();
  }

  // Users

  userById(id: number): UserRow | null {
    return this.db.query<UserRow, [number]>("SELECT * FROM users WHERE id = ?").get(id);
  }

  userByTelegramId(telegramId: number): UserRow | null {
    return this.db
      .query<UserRow, [number]>("SELECT * FROM users WHERE telegram_id = ?")
      .get(telegramId);
  }

  upsertTelegramUser(telegramId: number, name: string): UserRow {
    const row = this.db
      .query<UserRow, [number, string, number]>(
        `INSERT INTO users (telegram_id, name, created_at) VALUES (?, ?, ?)
         ON CONFLICT (telegram_id) DO UPDATE SET name = excluded.name
         RETURNING *`,
      )
      .get(telegramId, name, Date.now());
    if (!row) throw new Error("Failed to upsert user");
    return row;
  }

  setAllowed(userId: number, allowed: boolean): void {
    this.db.query("UPDATE users SET allowed = ? WHERE id = ?").run(allowed ? 1 : 0, userId);
  }

  allowedUsers(): UserRow[] {
    return this.db.query<UserRow, []>("SELECT * FROM users WHERE allowed = 1 ORDER BY id").all();
  }

  // Invites

  createInvite(createdBy: number): string {
    const code = `inv${randomCode(12)}`;
    this.db
      .query("INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)")
      .run(code, createdBy, Date.now());
    return code;
  }

  useInvite(code: string, userId: number): boolean {
    const res = this.db
      .query("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL")
      .run(userId, Date.now(), code);
    return res.changes === 1;
  }

  // Companion pairing

  createPairCode(userId: number): string {
    const now = Date.now();
    this.db.query("DELETE FROM pair_codes WHERE expires_at < ? OR user_id = ?").run(now, userId);
    const code = randomCode(10);
    this.db
      .query("INSERT INTO pair_codes (code, user_id, expires_at) VALUES (?, ?, ?)")
      .run(code, userId, now + PAIR_CODE_TTL_MS);
    return code;
  }

  consumePairCode(code: string): number | null {
    const row = this.db
      .query<{ user_id: number }, [string, number]>(
        "DELETE FROM pair_codes WHERE code = ? AND expires_at >= ? RETURNING user_id",
      )
      .get(code.toUpperCase(), Date.now());
    return row?.user_id ?? null;
  }

  createDevice(userId: number, name: string): string {
    const token = randomToken();
    this.db
      .query("INSERT INTO devices (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(userId, name, hashToken(token), Date.now());
    return token;
  }

  deviceByToken(token: string): DeviceRow | null {
    const row = this.db
      .query<DeviceRow, [number, string]>(
        `UPDATE devices SET last_seen_at = ? WHERE token_hash = ?
         RETURNING id, user_id, name, created_at, last_seen_at`,
      )
      .get(Date.now(), hashToken(token));
    return row;
  }

  devices(userId: number): DeviceRow[] {
    return this.db
      .query<DeviceRow, [number]>(
        "SELECT id, user_id, name, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY id",
      )
      .all(userId);
  }

  deleteDevices(userId: number): number {
    return this.db.query("DELETE FROM devices WHERE user_id = ?").run(userId).changes;
  }

  // Items

  createItem(item: Pick<ItemRow, "id" | "user_id" | "chat_id" | "source" | "dir" | "input_name" | "caption" | "taken_at">): ItemRow {
    const now = Date.now();
    const row = this.db
      .query<ItemRow, SQLQueryBindings[]>(
        `INSERT INTO items (id, user_id, chat_id, source, dir, input_name, caption, taken_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?) RETURNING *`,
      )
      .get(item.id, item.user_id, item.chat_id, item.source, item.dir, item.input_name, item.caption, item.taken_at, now, now);
    if (!row) throw new Error("Failed to create item");
    return row;
  }

  item(id: string): ItemRow | null {
    return this.db.query<ItemRow, [string]>("SELECT * FROM items WHERE id = ?").get(id);
  }

  updateItem(id: string, patch: ItemPatch): ItemRow {
    const sets: string[] = ["updated_at = ?"];
    const values: SQLQueryBindings[] = [Date.now()];
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(value);
    }
    values.push(id);
    const row = this.db
      .query<ItemRow, SQLQueryBindings[]>(`UPDATE items SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
      .get(...values);
    if (!row) throw new Error(`Item ${id} not found`);
    return row;
  }

  // Atomically hand the oldest queued item of a user to a companion.
  claimNext(userId: number): ItemRow | null {
    const now = Date.now();
    return this.db
      .query<ItemRow, [number, number, number]>(
        `UPDATE items SET status = 'uploading', claimed_at = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM items WHERE user_id = ? AND status = 'queued' ORDER BY updated_at LIMIT 1
         )
         RETURNING *`,
      )
      .get(now, now, userId);
  }

  // Items a companion claimed but never reported back (crash, network loss) go back to the queue.
  requeueStale(maxAgeMs: number): ItemRow[] {
    const now = Date.now();
    return this.db
      .query<ItemRow, [number, number]>(
        `UPDATE items SET status = 'queued', claimed_at = NULL, updated_at = ?
         WHERE status = 'uploading' AND claimed_at < ? RETURNING *`,
      )
      .all(now, now - maxAgeMs);
  }

  queuedCount(userId: number): number {
    const row = this.db
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND status = 'queued'")
      .get(userId);
    return row?.n ?? 0;
  }

  itemsOlderThan(timestamp: number): ItemRow[] {
    return this.db.query<ItemRow, [number]>("SELECT * FROM items WHERE created_at < ?").all(timestamp);
  }

  deleteItem(id: string): void {
    this.db.query("DELETE FROM items WHERE id = ?").run(id);
  }
}

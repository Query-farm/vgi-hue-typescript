/**
 * Transactional light changes: `ATTACH ... (transactional true)`.
 *
 *   BEGIN;
 *   UPDATE hue.main.lights SET is_on = true, brightness = 40 WHERE room = 'Kitchen';
 *   SELECT * FROM hue.main.recall_scene('Relax', room := 'Living room');
 *   COMMIT;      -- every change is sent now, together
 *   -- or ROLLBACK: nothing was sent, no light changed
 *
 * In a transactional attach, UPDATE and the control functions do not call the
 * bridge. They stage their requests under the transaction id DuckDB passes on
 * every call, and the catalog's commit hook sends them, in order, once the
 * transaction commits. Rollback discards them. DuckDB wraps every statement in
 * a transaction, so outside BEGIN ... COMMIT a statement simply applies when
 * it commits, right after it runs; a bridge refusal then fails the statement.
 *
 * The bridge itself has no transactions. Commit records the state of every
 * light it is about to touch, and if the bridge refuses a request part-way it
 * restores the lights already changed before reporting the error: all or
 * nothing in practice, not ACID. Room commands and scenes restore through the
 * lights they cover.
 *
 * Staged requests live in a small SQLite file shared by the worker's
 * processes (DuckDB may route the statements of one transaction to different
 * worker processes), so an HTTP deployment needs its workers on one host.
 * Functions see the same plaintext transaction id as the commit hook from
 * @query-farm/vgi 0.48.4 on (earlier SDKs passed it sealed over HTTP; see
 * `stageable`).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BridgeConnection,
  getResources,
  HueError,
  type HueGroup,
  type HueLight,
  hueRequest,
  lightsInGroup,
  pace,
} from "./hue.ts";
import { log } from "./log.ts";

/** Plaintext transaction ids this worker mints are 16 random bytes. */
const TX_ID_BYTES = 16;
/** Staged requests older than this belong to abandoned transactions. */
const STALE_MS = 24 * 3600 * 1000;

export type StagedKind = "light" | "grouped_light" | "scene";

export interface StagedRequest {
  kind: StagedKind;
  /** Resource id the PUT targets. */
  target: string;
  body: Record<string, unknown>;
}

function dbPath(env: Record<string, string | undefined> = process.env): string {
  const dir = env.HUE_TX_DIR || join(tmpdir(), "vgi-hue");
  mkdirSync(dir, { recursive: true });
  return join(dir, "transactions.db");
}

function open(): Database {
  const db = new Database(dbPath(), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS staged (seq INTEGER PRIMARY KEY AUTOINCREMENT, tx TEXT NOT NULL, " +
      "kind TEXT NOT NULL, target TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS staged_tx ON staged (tx, seq)");
  return db;
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** A fresh transaction id (also sweeps requests left by abandoned transactions). */
export function beginTransaction(): Uint8Array {
  const id = new Uint8Array(TX_ID_BYTES);
  crypto.getRandomValues(id);
  const db = open();
  try {
    db.query("DELETE FROM staged WHERE created < ?").run(Date.now() - STALE_MS);
  } finally {
    db.close();
  }
  return id;
}

/**
 * The transaction id a function call can stage under, or null when it should
 * act immediately. Throws over HTTP, where the id arrives sealed.
 */
export function stageable(transactional: boolean, txId: Uint8Array | null | undefined): Uint8Array | null {
  if (!transactional || txId == null || txId.length === 0) return null;
  if (txId.length !== TX_ID_BYTES) {
    // A sealed envelope: the SDK predates function-side unsealing (0.48.4).
    throw new HueError(
      "transactional mode needs @query-farm/vgi 0.48.4 or later over HTTP: this worker received the " +
        "transaction id sealed. Attach without `transactional` to apply changes at once.",
    );
  }
  return txId;
}

export function stage(txId: Uint8Array, requests: StagedRequest[]): void {
  if (!requests.length) return;
  const db = open();
  try {
    const insert = db.query("INSERT INTO staged (tx, kind, target, body, created) VALUES (?, ?, ?, ?, ?)");
    const now = Date.now();
    db.transaction(() => {
      for (const r of requests) insert.run(hex(txId), r.kind, r.target, JSON.stringify(r.body), now);
    })();
  } finally {
    db.close();
  }
}

export function staged(txId: Uint8Array): StagedRequest[] {
  const db = open();
  try {
    const rows = db.query("SELECT kind, target, body FROM staged WHERE tx = ? ORDER BY seq").all(hex(txId)) as {
      kind: StagedKind;
      target: string;
      body: string;
    }[];
    return rows.map((r) => ({ kind: r.kind, target: r.target, body: JSON.parse(r.body) }));
  } finally {
    db.close();
  }
}

function discard(txId: Uint8Array): void {
  const db = open();
  try {
    db.query("DELETE FROM staged WHERE tx = ?").run(hex(txId));
  } finally {
    db.close();
  }
}

/** Light-level staged changes per light id, merged in order (for reads inside the transaction). */
export function pendingLightBodies(txId: Uint8Array): Map<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>();
  for (const r of staged(txId)) {
    if (r.kind !== "light") continue;
    out.set(r.target, [...(out.get(r.target) ?? []), r.body]);
  }
  return out;
}

/** The PUT path of a staged request. */
const pathOf = (r: StagedRequest) => `/resource/${r.kind}/${encodeURIComponent(r.target)}`;

/**
 * Merge back-to-back state changes to the same light into one request, so a
 * transaction that sets brightness then colour sends a single command. A
 * rename stays its own request (a bridge ignores state sent alongside one).
 */
export function coalesce(requests: StagedRequest[]): StagedRequest[] {
  const out: StagedRequest[] = [];
  for (const r of requests) {
    const last = out[out.length - 1];
    const isState = !("metadata" in r.body);
    if (
      last &&
      isState &&
      last.kind === "light" &&
      r.kind === "light" &&
      last.target === r.target &&
      !("metadata" in last.body)
    ) {
      const merged = { ...last.body, ...r.body };
      // A colour replaces a white temperature and vice versa.
      if ("color" in r.body) delete merged.color_temperature;
      if ("color_temperature" in r.body) delete merged.color;
      out[out.length - 1] = { ...last, body: merged };
    } else {
      out.push(r);
    }
  }
  return out;
}

/** A light's restorable state, as a PUT body. */
function restoreBody(l: HueLight): Record<string, unknown> {
  const body: Record<string, unknown> = { on: { on: l.on?.on ?? false } };
  if (l.dimming) body.dimming = { brightness: l.dimming.brightness };
  if (l.color_temperature?.mirek != null) body.color_temperature = { mirek: l.color_temperature.mirek };
  else if (l.color?.xy) body.color = { xy: l.color.xy };
  return body;
}

/** Ids of the lights a request touches (rooms and scenes through their members). */
async function touchedLights(
  conn: BridgeConnection,
  requests: StagedRequest[],
  lights: HueLight[],
): Promise<Set<string>> {
  const ids = new Set(requests.filter((r) => r.kind === "light").map((r) => r.target));
  if (requests.some((r) => r.kind !== "light")) {
    const [rooms, zones, scenes] = await Promise.all([
      getResources<HueGroup>(conn, "room"),
      getResources<HueGroup>(conn, "zone"),
      getResources<{ id: string; group?: { rid: string } }>(conn, "scene"),
    ]);
    const groups = [...rooms, ...zones];
    for (const r of requests) {
      const group =
        r.kind === "grouped_light"
          ? groups.find((g) => g.services?.some((s) => s.rid === r.target))
          : r.kind === "scene"
            ? groups.find((g) => g.id === scenes.find((s) => s.id === r.target)?.group?.rid)
            : undefined;
      if (group) for (const l of lightsInGroup(group, lights)) ids.add(l.id);
    }
  }
  return ids;
}

/**
 * Send a transaction's staged requests. On a refusal, put back the lights
 * already changed and throw; the staged requests are discarded either way.
 */
export async function commitTransaction(connect: () => Promise<BridgeConnection>, txId: Uint8Array): Promise<void> {
  const requests = coalesce(staged(txId));
  discard(txId);
  if (!requests.length) return; // nothing staged: never touch the network
  const conn = await connect();
  const lights = await getResources<HueLight>(conn, "light");
  const before = new Map(lights.map((l) => [l.id, l]));
  const touched = await touchedLights(conn, requests, lights);
  let sent = 0;
  try {
    for (const r of requests) {
      await pace(r.kind === "light" ? "light" : "group");
      await hueRequest(conn, "PUT", pathOf(r), r.body);
      sent++;
    }
  } catch (err) {
    const restored = await restoreLights(conn, sent ? touched : new Set(), before);
    throw new HueError(
      `COMMIT failed after ${sent} of ${requests.length} light changes: ${(err as Error).message}. ` +
        (sent ? `Restored ${restored} light(s) to their state before the commit.` : "Nothing was changed."),
    );
  }
}

async function restoreLights(conn: BridgeConnection, ids: Set<string>, before: Map<string, HueLight>): Promise<number> {
  let restored = 0;
  for (const id of ids) {
    const light = before.get(id);
    if (!light) continue;
    try {
      await pace("light");
      await hueRequest(conn, "PUT", `/resource/light/${id}`, restoreBody(light));
      restored++;
    } catch (err) {
      log.warn(`could not restore light ${id} after a failed commit: ${(err as Error).message}`);
    }
  }
  return restored;
}

export function rollbackTransaction(txId: Uint8Array): void {
  discard(txId);
}

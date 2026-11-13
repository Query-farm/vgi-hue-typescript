/**
 * The staging store must survive many worker processes opening a fresh file at
 * the same moment (the WAL-switch race behind "disk I/O error (1546)" on Windows).
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTransientSqliteError } from "../src/transactions.ts";

const PROCESSES = 12;

test(`${PROCESSES} processes open one fresh store at once`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "vgi-hue-wal-"));
  try {
    const dbFile = join(dir, "transactions.db");
    const barrier = join(dir, "go");
    const children = Array.from({ length: PROCESSES }, () =>
      Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "open_store.ts"), dbFile, barrier], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const readers = children.map((c) => c.stdout.getReader());
    const seen = children.map(() => "");
    // Barrier: every child has started and is spinning on the go file.
    await Promise.all(
      readers.map(async (r, i) => {
        while (!seen[i]?.includes("READY")) {
          const { value, done } = await r.read();
          if (done) break;
          seen[i] += new TextDecoder().decode(value);
        }
      }),
    );
    writeFileSync(barrier, "");
    const results = await Promise.all(
      children.map(async (c, i) => {
        const reader = readers[i] as ReadableStreamDefaultReader<Uint8Array>;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          seen[i] += new TextDecoder().decode(value);
        }
        return { code: await c.exited, out: seen[i], err: await new Response(c.stderr).text() };
      }),
    );
    for (const r of results) {
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(r.out).toContain("OK");
    }
    const db = new Database(dbFile, { readonly: true });
    try {
      const objects = db.query("SELECT type, name FROM sqlite_master WHERE name IN ('staged', 'staged_tx')").all();
      expect(objects).toEqual([
        { type: "table", name: "staged" },
        { type: "index", name: "staged_tx" },
      ]);
      expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      expect((db.query("SELECT count(*) AS n FROM staged").get() as { n: number }).n).toBe(PROCESSES);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("transient SQLite errors are recognised", () => {
  expect(isTransientSqliteError({ code: "SQLITE_BUSY" })).toBe(true);
  expect(isTransientSqliteError({ code: "SQLITE_IOERR_TRUNCATE" })).toBe(true);
  expect(isTransientSqliteError({ errno: 1546 })).toBe(true);
  expect(isTransientSqliteError(new Error('applying "PRAGMA journal_mode=WAL": disk I/O error (1546)'))).toBe(true);
  expect(isTransientSqliteError({ code: "SQLITE_CONSTRAINT" })).toBe(false);
  expect(isTransientSqliteError(new Error("no such table"))).toBe(false);
});

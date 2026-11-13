// Child process for tests/sqlite_wal.test.ts: waits for the barrier file, then
// opens the staging store and stages one request through the same connection.
import { existsSync } from "node:fs";
import { open } from "../../src/transactions.ts";

const [dbFile, barrier] = process.argv.slice(2) as [string, string];
process.stdout.write("READY\n");
while (!existsSync(barrier)) Bun.sleepSync(1);
const db = open(dbFile);
try {
  db.query("INSERT INTO staged (tx, kind, target, body, created) VALUES (?, 'light', 't', '{}', ?)").run(
    `p${process.pid}`,
    Date.now(),
  );
} finally {
  db.close();
}
process.stdout.write("OK\n");

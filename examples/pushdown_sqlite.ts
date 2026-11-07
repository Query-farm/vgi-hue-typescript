/**
 * Recipe: push WHERE filters and column selection down into a database.
 *
 * DuckDB tells a table function which columns the query needs (projection
 * pushdown) and which predicates it can apply at the source (filter pushdown).
 * Turning those into the source's own query means less data crosses the wire.
 *
 *   SELECT id, amount FROM pushdown_sqlite.main.orders() WHERE region = 'west' AND amount > 900;
 *
 * Only simple top-level comparisons, IN lists and IS [NOT] NULL are translated
 * here; anything else is left for DuckDB, which always re-checks every row it
 * receives, so partial pushdown is safe. The demo database (bun:sqlite, no
 * dependency) is created on first use in the system temp directory.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  batchFromColumns,
  type CatalogDescriptor,
  defineTableFunction,
  field,
  int64,
  type PushdownFilters,
  schema,
  utf8,
} from "@query-farm/vgi";
import { log } from "../src/log.ts";

const DB_PATH = join(tmpdir(), "vgi_recipe_orders.sqlite");
const PAGE = 500;
const SQL_OP: Record<string, string> = { eq: "=", ne: "<>", gt: ">", ge: ">=", lt: "<", le: "<=" };
const FLIPPED: Record<string, string> = { eq: "eq", ne: "ne", gt: "lt", ge: "le", lt: "gt", le: "ge" };

const ORDERS_SCHEMA = schema([field("id", int64(), false), field("region", utf8()), field("amount", int64())]);

/** Create a deterministic 2,000-row orders table if it does not exist. */
function ensureDb(): void {
  if (existsSync(DB_PATH)) return;
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  const db = new Database(tmp, { create: true });
  db.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, region TEXT NOT NULL, amount INTEGER NOT NULL)");
  const insert = db.prepare("INSERT INTO orders VALUES (?, ?, ?)");
  const regions = ["north", "south", "east", "west"];
  db.transaction(() => {
    for (let i = 1; i <= 2000; i++) insert.run(i, regions[i % 4] ?? "north", (i * 37) % 1000);
  })();
  // Finalize before closing: Windows can't rename a file that is still open.
  insert.finalize();
  db.close(true);
  try {
    renameSync(tmp, DB_PATH);
  } catch (err) {
    // Another worker process created the database first; use theirs.
    rmSync(tmp, { force: true });
    if (!existsSync(DB_PATH)) throw err;
  }
}

type Expr = PushdownFilters["filters"][number];

/** Strip casts DuckDB wraps around constants and columns. */
function unwrap(e: Expr): Expr {
  return e.node === "cast" ? unwrap(e.expression) : e;
}

/** Translate one predicate into parameterized SQL, or undefined to leave it to DuckDB. */
function toSql(e: Expr, values: SQLQueryBindings[]): string | undefined {
  if (e.node === "and") {
    const parts = e.children.map((c) => toSql(c, values)).filter((p) => p !== undefined);
    return parts.length ? parts.join(" AND ") : undefined;
  }
  if (e.node === "comparison" && e.op in SQL_OP) {
    const [left, right] = [unwrap(e.left), unwrap(e.right)];
    if (left.node === "column_ref" && right.node === "literal") {
      values.push(right.value as SQLQueryBindings);
      return `"${left.columnName}" ${SQL_OP[e.op]} ?`;
    }
    if (left.node === "literal" && right.node === "column_ref") {
      values.push(left.value as SQLQueryBindings);
      return `"${right.columnName}" ${SQL_OP[FLIPPED[e.op] ?? e.op]} ?`;
    }
  }
  if (e.node === "in" && !e.negated && e.set.kind === "literal") {
    const col = unwrap(e.expression);
    if (col.node === "column_ref" && e.set.values.length > 0) {
      values.push(...(e.set.values as SQLQueryBindings[]));
      return `"${col.columnName}" IN (${e.set.values.map(() => "?").join(", ")})`;
    }
  }
  if (e.node === "is_null") {
    const col = unwrap(e.expression);
    if (col.node === "column_ref") return `"${col.columnName}" IS ${e.negated ? "NOT " : ""}NULL`;
  }
  return undefined; // OR, functions, expressions: not pushed; DuckDB applies them.
}

/** Scan the SQLite `orders` table, pushing filters and projections into SQL. */
export const orders = defineTableFunction<Record<string, never>, { lastId: number }>({
  name: "orders",
  description: "Orders from a SQLite database, with filter and projection pushdown",
  filterPushdown: true,
  projectionPushdown: true,
  onBind: () => ({ outputSchema: ORDERS_SCHEMA }),

  // Keyset pagination cursor: the last id emitted.
  initialState: () => {
    ensureDb();
    return { lastId: 0 };
  },

  // Fetch one page of matching rows, selecting only the projected columns.
  process: (params, state, out) => {
    const wanted = params.outputSchema.fields.map((f) => f.name);
    const values: SQLQueryBindings[] = [state.lastId];
    const clauses = ["id > ?"];
    for (const predicate of params.pushdownFilters?.filters ?? []) {
      const sql = toSql(predicate, values);
      if (sql) clauses.push(sql);
    }
    const select = ["id", ...wanted.map((c) => `"${c}"`)].join(", ");
    const sql = `SELECT ${select} FROM orders WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ${PAGE}`;
    log.debug(`sqlite: ${sql} ${JSON.stringify(values, (_k, v) => (typeof v === "bigint" ? String(v) : v))}`);
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db.query(sql).values(...values) as (number | string | null)[][];
    db.close();
    const last = rows.at(-1);
    if (!last) {
      out.finish();
      return;
    }
    state.lastId = Number(last[0]);
    const columns = Object.fromEntries(
      wanted.map((name, i) => [name, rows.map((r) => (name === "region" ? r[i + 1] : BigInt(r[i + 1] ?? 0)))]),
    );
    out.emit(batchFromColumns(columns, params.outputSchema));
  },
});

export const catalog: CatalogDescriptor = {
  name: "pushdown_sqlite",
  schemas: [{ path: ["main"], functions: [orders] }],
};

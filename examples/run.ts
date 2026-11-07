/**
 * Run one recipe as a worker: `bun run examples/run.ts <recipe> [worker flags]`.
 *
 *   ATTACH 'aggregate' (TYPE vgi, LOCATION 'bun run /abs/examples/run.ts aggregate');
 *
 * Each recipe module exports a `catalog`; the shared CLI in src/cli.ts serves it
 * over stdio, --unix or --http, exactly like the main worker.
 */

import type { CatalogDescriptor } from "@query-farm/vgi";
import { serve } from "../src/cli.ts";
import * as aggregate from "./aggregate.ts";
import * as cacheExpensiveCall from "./cache_expensive_call.ts";
import * as catalogTables from "./catalog_tables.ts";
import * as copyToSink from "./copy_to_sink.ts";
import * as pushdownSqlite from "./pushdown_sqlite.ts";
import * as transformRows from "./transform_rows.ts";

export const RECIPES: Record<string, CatalogDescriptor> = {
  transform_rows: transformRows.catalog,
  aggregate: aggregate.catalog,
  pushdown_sqlite: pushdownSqlite.catalog,
  cache_expensive_call: cacheExpensiveCall.catalog,
  catalog_tables: catalogTables.catalog,
  copy_to_sink: copyToSink.catalog,
};

if (import.meta.main) {
  const [name, ...rest] = process.argv.slice(2);
  const catalog = name === undefined ? undefined : RECIPES[name];
  if (!catalog) {
    process.stderr.write(`usage: run.ts <${Object.keys(RECIPES).join("|")}> [worker flags]\n`);
    process.exit(2);
  }
  serve(catalog, { version: "0.1.0", doc: `The ${name} recipe from the VGI starter template.` }, rest);
}

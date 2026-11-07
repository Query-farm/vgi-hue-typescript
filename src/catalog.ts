/**
 * Assemble the functions into the catalog DuckDB attaches.
 *
 * To add a function: write it, then add it to `FUNCTIONS` below.
 * The `bridge` / `app_key` ATTACH options are declared in `attach.ts`.
 */

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { recallSceneFn, setLightFn, setLightsFn, setRoomFn } from "./control.ts";
import { lightsTable, roomsTable, scenesTable, sensorsTable } from "./inventory.ts";
import { CATALOG_DOC_MD, CATALOG_NAME, CATALOG_TAGS, SCHEMA_DOC_MD, SCHEMA_TAGS, SOURCE_URL } from "./meta.ts";

/** Read-only inventory, exposed as tables: SELECT * FROM hue.main.lights. */
export const TABLES = [lightsTable, roomsTable, scenesTable, sensorsTable].map((t) => t.table);

/** Control functions. */
export const FUNCTIONS: VgiFunction[] = [setLightFn, setRoomFn, recallSceneFn, setLightsFn];

interface Example {
  description: string;
  sql: string;
}

/**
 * Publish each function's examples as `vgi.example_queries` (with descriptions).
 *
 * Overloads share one SQL name, so their examples are merged per name.
 * Returns every example, for the schema-level list.
 */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const byName = new Map<string, Example[]>();
  for (const fn of functions) {
    const bucket = byName.get(fn.meta.name) ?? [];
    byName.set(fn.meta.name, bucket);
    for (const ex of fn.meta.examples ?? []) {
      if (!bucket.some((e) => e.sql === ex.sql)) bucket.push({ description: ex.description, sql: ex.sql });
    }
  }
  for (const fn of functions) {
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(byName.get(fn.meta.name)) };
  }
  return [...byName.values()].flat();
}

const ALL_EXAMPLES = [
  ...TABLES.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]),
  ...stampExampleQueries(FUNCTIONS),
];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_DOC_MD,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: FUNCTIONS,
      tables: TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES) },
    },
  ],
};

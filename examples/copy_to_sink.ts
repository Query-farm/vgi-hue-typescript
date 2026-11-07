/**
 * Recipe: write query results out with `COPY … TO` and a custom format.
 *
 *   ATTACH 'copy_to_sink' (TYPE vgi, LOCATION '…/run.ts copy_to_sink');
 *   COPY (SELECT * FROM t) TO 'out.jsonl' (FORMAT 'copy_to_sink.jsonl_out');
 *
 * The format name is qualified by the attach alias. `write` runs once per
 * batch (possibly in parallel, possibly in different processes), so it stashes
 * rows in `params.storage`; `close` runs once and writes the file. Swap the
 * file write for an upload to object storage, a warehouse load, or an API call.
 */

import { writeFileSync } from "node:fs";
// `bool` here is the ready-made Arrow Bool type (like `str` and `int`), not a factory.
import { bool, type CatalogDescriptor, defineCopyToFunction, iterRows } from "@query-farm/vgi";

const SHARDS = new TextEncoder().encode("shards");
const NO_KEY = new Uint8Array(0);

interface WriteOptions {
  sort_keys: boolean;
}

/** JSON-encode one row; BIGINT values (bigint) are written as numbers. */
function toJson(row: Record<string, unknown>, sortKeys: boolean): string {
  const keys = sortKeys ? Object.keys(row).sort() : Object.keys(row);
  const ordered = Object.fromEntries(keys.map((k) => [k, row[k]]));
  return JSON.stringify(ordered, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
}

export const writeJsonLines = defineCopyToFunction<WriteOptions>({
  name: "write_json_lines",
  format: "jsonl_out",
  description: "Write each row as one JSON object per line",
  comment: "Newline-delimited JSON, one object per row",
  options: { sort_keys: { type: bool, default: false, doc: "Sort the keys of each JSON object" } },

  // Serialize this batch and stash it (scoped to this COPY by execution id).
  write: async ({ batch, options, params }) => {
    const lines = Array.from(iterRows(batch), (row) => toJson(row, options.sort_keys));
    if (lines.length > 0) await params.storage.stateAppend(SHARDS, NO_KEY, new TextEncoder().encode(lines.join("\n")));
  },

  // Write every stashed batch to the file once; return the row count.
  close: async ({ filePath, params }) => {
    const chunks = (await params.storage.stateLogScan(SHARDS, NO_KEY, -1)).map(([, blob]) =>
      new TextDecoder().decode(blob),
    );
    writeFileSync(filePath, chunks.map((c) => `${c}\n`).join(""), "utf-8");
    return chunks.reduce((n, c) => n + c.split("\n").length, 0);
  },
});

export const catalog: CatalogDescriptor = {
  name: "copy_to_sink",
  schemas: [{ path: ["main"], functions: [writeJsonLines] }],
};

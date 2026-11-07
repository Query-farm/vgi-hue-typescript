/**
 * Table function example: `sequence_table`.
 *
 * A table function returns a set of rows. This one is a deterministic
 * generator, the simplest shape to learn from:
 *
 * - `count` is positional and required; `step` is *named* with a default
 *   (`argDefaults`), so callers write `sequence_table(5)` or
 *   `sequence_table(5, step := 2)`. (Named arguments work on table functions,
 *   not on scalars.)
 * - `argConstraints` (`ge`/`le`) are enforced before the function runs and are
 *   published so agents know the valid range.
 * - Output streams in bounded batches. `SequenceState` remembers where the last
 *   batch stopped. It is a plain JSON-friendly object, so the same code works
 *   when DuckDB talks to the worker over HTTP, where the state travels with
 *   each request and each batch may hit a different process.
 */

import { batchFromColumns, defineTableFunction, int64, schema } from "@query-farm/vgi";
import { column, objectTags } from "./meta.ts";

export const BATCH_ROWS = 10_000;
export const MAX_COUNT = 1_000_000;

export const SEQUENCE_SCHEMA = schema([
  column("n", int64(), "The generated value: row index times step.", false),
  column("squared", int64(), "n multiplied by itself.", false),
]);

interface SequenceArgs {
  count: bigint;
  step: bigint;
}

/** Cursor: how many rows have been emitted so far. */
interface SequenceState {
  emitted: number;
}

/** Rows `[start, start + rows)` of the sequence as columns. */
export function sequenceColumns(start: number, rows: number, step: bigint): { n: bigint[]; squared: bigint[] } {
  const n = Array.from({ length: rows }, (_, i) => BigInt(start + i) * step);
  return { n, squared: n.map((v) => v * v) };
}

export const sequenceTable = defineTableFunction<SequenceArgs, SequenceState>({
  name: "sequence_table",
  description: "Generate count rows of (n, squared), stepping n by step",
  args: { count: int64(), step: int64() },
  argDefaults: { step: 1 },
  argDocs: {
    count: "How many rows to generate, from 0 to 1,000,000.",
    step: "Gap between consecutive n values; at least 1.",
  },
  argConstraints: { count: { ge: 0, le: MAX_COUNT }, step: { ge: 1 } },

  onBind: () => ({ outputSchema: SEQUENCE_SCHEMA }),

  // Tell the planner exactly how many rows to expect.
  cardinality: ({ args }) => ({ estimate: args.count, max: args.count }),

  initialState: () => ({ emitted: 0 }),

  // Emit one bounded batch per call; finish when `count` rows are out.
  process: (params, state, out) => {
    const count = Number(params.args.count);
    if (state.emitted >= count) {
      out.finish();
      return;
    }
    const rows = Math.min(BATCH_ROWS, count - state.emitted);
    out.emit(batchFromColumns(sequenceColumns(state.emitted, rows, BigInt(params.args.step)), params.outputSchema));
    state.emitted += rows;
  },

  tags: {
    ...objectTags({
      title: "Sequence Table",
      category: "generators",
      keywords: "sequence, series, range, generate rows, numbers, squares",
      docLlm:
        "Generate a deterministic table of `count` rows with columns `n` and `squared`, " +
        "where `n` runs 0, step, 2*step, and so on. `count` is positional (0 to 1,000,000); " +
        "`step` is a named argument that defaults to 1. Rows stream back in batches, so large " +
        "counts do not buffer in memory. A call with count 5 and step 2 returns n = 0, 2, 4, 6, 8.",
      docMd:
        "## sequence_table(count, step := 1)\n\n" +
        "`count` rows of `(n, squared)` with n = 0, step, 2*step, ...\n\n" +
        "Deterministic, so it is handy for tests and demos.",
    }),
    "vgi.result_columns_schema": JSON.stringify([
      { name: "n", type: "BIGINT", description: "The generated value: row index times step." },
      { name: "squared", type: "BIGINT", description: "n multiplied by itself." },
    ]),
    "vgi.executable_examples": JSON.stringify([
      {
        description: "Three rows stepping by two",
        sql: "SELECT n, squared FROM starter.main.sequence_table(3, step := 2) ORDER BY n",
        expected_result: [
          [0, 0],
          [2, 4],
          [4, 16],
        ],
      },
      {
        description: "Count the rows generated",
        sql: "SELECT count(*) AS rows FROM starter.main.sequence_table(1000)",
        expected_result: [[1000]],
      },
    ]),
  },
  examples: [
    {
      sql: "SELECT n, squared FROM starter.main.sequence_table(5) ORDER BY n",
      description: "The first five values and their squares",
    },
    {
      sql: "SELECT n FROM starter.main.sequence_table(4, step := 10) ORDER BY n",
      description: "Four values stepping by ten",
    },
  ],
});

/**
 * Recipe: an aggregate function, driven by GROUP BY.
 *
 *   SELECT category, aggregate.main.int_sum(amount) FROM sales GROUP BY category;
 *
 * Aggregates keep per-group state across phases:
 *
 * - `update`   fold a batch of values into each group's state
 * - `combine`  merge partial states for the same group (parallel execution)
 * - `finalize` turn each group's state into one output value
 *
 * `combine` must be associative and commutative: DuckDB decides how many
 * workers run and in which order their partial states merge.
 */

import { batchFromColumns, type CatalogDescriptor, defineAggregate, int64 } from "@query-farm/vgi";

interface SumState {
  total: bigint;
}

export const intSum = defineAggregate<{ value: bigint }, SumState>({
  name: "int_sum",
  description: "Sum integer values per group",
  args: { value: int64() },
  outputType: int64(),
  // DEFAULT: DuckDB skips NULL inputs, so update() never sees one.
  nullHandling: "DEFAULT",

  initialState: () => ({ total: 0n }),

  update: ({ groupIds, columns, ensureState }) => {
    const values = columns[0];
    for (let i = 0; i < groupIds.length; i++) {
      const v = values?.get(i) as bigint | number | null;
      if (v == null) continue;
      ensureState(groupIds[i] as bigint).total += BigInt(v);
    }
  },

  combine: (source, target) => ({ total: source.total + target.total }),

  // One row per group id, in the order given; a group with no state is NULL.
  finalize: ({ groupIds, states, outputSchema }) =>
    batchFromColumns({ result: groupIds.map((gid) => states.get(gid)?.total ?? null) }, outputSchema),
});

export const catalog: CatalogDescriptor = {
  name: "aggregate",
  schemas: [{ path: ["main"], functions: [intSum] }],
};

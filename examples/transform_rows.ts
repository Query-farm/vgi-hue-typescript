/**
 * Recipe: transform the rows of a query with a table in-out function.
 *
 * A table in-out function receives another query's rows, batch by batch, and
 * emits rows back. Use it to clean, enrich, filter or reshape data in SQL:
 *
 *   SELECT * FROM transform_rows.main.positive_only((SELECT * FROM readings));
 *
 * Here: keep only rows whose `value` column is greater than zero. The output
 * schema equals the input schema, so it works on any table that has a `value`
 * column.
 */

import { type CatalogDescriptor, defineTableInOutFunction, filterBatch } from "@query-farm/vgi";

export const positiveOnly = defineTableInOutFunction({
  name: "positive_only",
  description: "Keep the rows of a query whose value column is positive",

  // The TABLE argument is implicit: it arrives as the batches process() is
  // called with, and its schema is on bindCall.input_schema.
  onBind: (params) => {
    const input = params.bindCall.input_schema;
    if (!input?.fields.some((f) => f.name === "value")) {
      throw new Error("positive_only needs an input column named 'value'");
    }
    return { outputSchema: input };
  },

  // Filter each incoming batch and emit the survivors. NULL values are dropped.
  process: (_params, _state, batch, out) => {
    const value = batch.getChild("value");
    const keep = new Uint8Array(batch.numRows);
    for (let i = 0; i < batch.numRows; i++) {
      const v = value?.get(i) as number | bigint | null;
      keep[i] = v != null && v > 0 ? 1 : 0;
    }
    out.emit(filterBatch(batch, keep));
  },
});

export const catalog: CatalogDescriptor = {
  name: "transform_rows",
  schemas: [{ path: ["main"], functions: [positiveOnly] }],
};

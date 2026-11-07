/**
 * Recipe: expose a dataset as a named table, with a primary key.
 *
 * A catalog table is queried by name, with no parentheses, like any DuckDB table:
 *
 *   SELECT * FROM catalog_tables.main.countries WHERE continent = 'Europe';
 *
 * Use a table for a fixed or slowly changing dataset (reference data, a
 * directory, a lookup list). Use a table function when the caller supplies
 * arguments. Declaring NOT NULL and a primary key tells the optimizer, and
 * agents, what identifies a row.
 *
 * Constraints are the worker's own attestation: declare a record as ENFORCED
 * with ALL_ROWS validation only if every row the table can return satisfies it.
 */

import {
  batchFromColumns,
  type CatalogDescriptor,
  constraintRecord,
  defineTableFunction,
  field,
  schema,
  utf8,
} from "@query-farm/vgi";

const COUNTRIES = {
  code: ["DE", "FR", "JP", "KE", "US"],
  name: ["Germany", "France", "Japan", "Kenya", "United States"],
  continent: ["Europe", "Europe", "Asia", "Africa", "North America"],
};

const COUNTRIES_SCHEMA = schema([field("code", utf8(), false), field("name", utf8()), field("continent", utf8())]);

/** Rows for the `countries` table. */
export const countriesSource = defineTableFunction<Record<string, never>, { done: boolean }>({
  name: "countries_source",
  description: "Backing rows for the countries table",
  onBind: () => ({ outputSchema: COUNTRIES_SCHEMA }),
  initialState: () => ({ done: false }),
  process: (params, state, out) => {
    if (state.done) {
      out.finish();
      return;
    }
    state.done = true;
    out.emit(batchFromColumns(COUNTRIES, params.outputSchema));
  },
});

export const catalog: CatalogDescriptor = {
  name: "catalog_tables",
  schemas: [
    {
      path: ["main"],
      functions: [countriesSource],
      tables: [
        {
          name: "countries",
          comment: "A small reference list of countries.",
          columns: COUNTRIES_SCHEMA,
          function: countriesSource,
          constraints: [
            constraintRecord({
              schemaPath: ["main"],
              table: "countries",
              id: "code_not_null",
              kind: "NOT_NULL",
              columns: [["code"]],
              enforcement: "ENFORCED",
              validation: "ALL_ROWS",
            }),
            constraintRecord({
              schemaPath: ["main"],
              table: "countries",
              id: "pk",
              kind: "PRIMARY_KEY",
              columns: [["code"]],
              enforcement: "ENFORCED",
              validation: "ALL_ROWS",
            }),
          ],
          columnComments: {
            code: "ISO 3166-1 alpha-2 country code.",
            name: "English short name.",
            continent: "Continent the country is in.",
          },
        },
      ],
    },
  ],
};
